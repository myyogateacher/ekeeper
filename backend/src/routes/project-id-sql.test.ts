import { afterAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { run } from "../db/sqlite";
import { HttpError } from "../lib/http";

// PROD-10582. A project id reaches ClickHouse from the URL (GET /api/projects/:projectId/errors) and
// requireProjectAccess lets an admin and a workspace viewer pass ANY string, existing project or not, so an id
// pasted into the SQL text is a way for a viewer, the read-only role, to write part of the query. These tests
// run the real routes against a real ClickHouse and write nothing to it: each query is prefixed with
// `WITH events AS (<rows below>)`, which shadows the real table for that one query, the approach of
// mcp-tools-clickhouse.test.ts. They write one project row to the configured SQLite per dashboard case and
// remove it in afterAll.

const realClickHouse = await import("../db/clickhouse");
const realClient = realClickHouse.getClickHouseClient();
let shadowTables = "";
mock.module("../db/clickhouse", () => ({
  ...realClickHouse,
  getClickHouseClient: () => ({
    query: (options: { query: string }) =>
      realClient.query(shadowTables ? ({ ...options, query: `WITH ${shadowTables} ${options.query}` } as typeof options & { format: "JSONEachRow" }) : (options as never)),
  }),
}));
const { apiRouter } = await import("./api");

afterAll(() => {
  shadowTables = "";
  run(`DELETE FROM projects WHERE id LIKE 'p_sqlinj_%'`);
});

const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

// The columns the list and the dashboard queries read, filled the way the ingest buffer fills a missing value.
function shadow(events: Array<{ project: string; group: string; user?: string }>) {
  const selects = events.map(
    (event, index) =>
      `SELECT ${literal(`e${index}`)} AS event_id, ${literal(event.project)} AS project_id, ${literal(event.group)} AS group_id, ${literal(event.group)} AS fingerprint, 'Error: boom' AS title, 'boom' AS message, 'error' AS severity, ${literal(event.user ?? "")} AS user_id, '' AS user_email, '' AS user_username, now64(3, 'UTC') AS timestamp`,
  );
  shadowTables = `events AS (${selects.join(" UNION ALL ")})`;
}

function appAs(role: "admin" | "manager" | "viewer", memberships: string[] = []) {
  const now = new Date().toISOString();
  const app = new Hono();
  app.use("*", async (ctx, next) => {
    ctx.set("auth", {
      user: { id: `u_${role}`, email: `${role}@test.example`, name: role, avatarUrl: null, role, status: "active", createdAt: now, updatedAt: now },
      memberships: memberships.map((projectId) => ({ userId: `u_${role}`, projectId, role: "manager", createdAt: now })),
      session: { id: "s", userId: `u_${role}`, expiresAt: now, createdAt: now },
    });
    await next();
  });
  app.onError((error, ctx) => (error instanceof HttpError ? ctx.json({ message: error.message }, error.status as 400 | 403) : ctx.json({ message: "Internal server error" }, 500)));
  app.route("/api", apiRouter);
  return app;
}

// Two real projects with one group each. A request for a project that holds neither must see neither.
const events = [
  { project: "pA", group: "gA", user: "u1" },
  { project: "pB", group: "gB", user: "u2" },
];

// Every one of these closes the quote or the parenthesis the old code opened, then changes what the WHERE means.
const hostileProjectIds = [
  "pZ') OR ('1'='1",
  "pZ' OR project_id != '",
  "pZ') OR 1=1 --",
  "pZ'||'",
  "a\\') OR ('1'='1",
  "x') OR project_id IN (SELECT project_id FROM events) OR ('",
];

describe("GET /api/projects/:projectId/errors reads only the project named, whatever the id holds", () => {
  const list = async (projectId: string, app = appAs("viewer")) => {
    const response = await app.request(`/api/projects/${encodeURIComponent(projectId)}/errors?limit=100`);
    return { status: response.status, body: (await response.json()) as { errors?: Array<{ projectId: string; groupId: string }>; total?: number; message?: string } };
  };

  test.each(hostileProjectIds)("the id %p returns no group of another project", async (projectId) => {
    shadow(events);

    const { status, body } = await list(projectId);

    expect([status, body.errors, body.total]).toEqual([200, [], 0]);
  });

  test("an id that exists returns its own groups and no other project's", async () => {
    shadow(events);

    const { body } = await list("pA");

    expect(body.errors?.map((entry) => [entry.projectId, entry.groupId])).toEqual([["pA", "gA"]]);
  });

  test("an id with an apostrophe in it is a project that has no groups, not an error", async () => {
    shadow(events);

    expect((await list("o'brien")).body).toMatchObject({ errors: [], total: 0 });
  });
});

describe("GET /api/dashboard/summary binds the project ids it lists, whatever they hold", () => {
  const cards = async () => {
    const response = await appAs("admin").request("/api/dashboard/summary");
    return { status: response.status, cards: ((await response.json()) as { cards?: Array<{ projectId: string; totalEvents7d: number }> }).cards ?? [] };
  };
  const now = new Date().toISOString();
  const insertProject = (id: string, slug: string) =>
    run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, id, slug, "production", 1, now, now]);

  // Project ids are generated by createId and cannot hold a quote today, and these ids come from SQLite, not from
  // a request. The dashboard still binds them: a row written by another path, or an id format that changes, must
  // not turn into SQL, and pasted raw one such project would fail the summary for every user.
  test("a project whose id holds an apostrophe is counted, and does not fail the summary for the others", async () => {
    const quoted = "p_sqlinj_o'brien";
    insertProject(quoted, "sqlinj-quoted");
    insertProject("p_sqlinj_ok", "sqlinj-ok");
    shadow([...events, { project: quoted, group: "gQ", user: "u3" }, { project: "p_sqlinj_ok", group: "gOk", user: "u4" }]);

    const { status, cards: result } = await cards();
    const byProject = new Map(result.map((card) => [card.projectId, card.totalEvents7d]));

    expect(status).toBe(200);
    expect(byProject.get(quoted)).toBe(1);
    expect(byProject.get("p_sqlinj_ok")).toBe(1);
  });

  test("a project whose id holds SQL counts only its own events", async () => {
    const hostile = "p_sqlinj_x') OR ('1'='1";
    insertProject(hostile, "sqlinj-hostile");
    shadow([...events, { project: hostile, group: "gH", user: "u5" }]);

    const { status, cards: result } = await cards();

    expect(status).toBe(200);
    expect(new Map(result.map((card) => [card.projectId, card.totalEvents7d])).get(hostile)).toBe(1);
  });
});
