import type { ClickHouseSettings } from "@clickhouse/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { ErrorDetailResponse } from "@ekeeper/shared";
import { config } from "../config";
import { run } from "../db/sqlite";
import { HttpError } from "../lib/http";

// These tests run the queries behind the issue page and the issues list header on a real ClickHouse, because SQL
// asserted as text proves nothing: the similar issues query parsed fine as a string and failed only in the engine
// (defect register entry 20). They need CLICKHOUSE_URL reachable, like mcp-tools-clickhouse.test.ts, whose
// approach they follow: nothing is written to ClickHouse. Each query is prefixed with `WITH events AS (<rows
// below>)`, which shadows the real table for that one query, so the rows below are the whole table. The handlers
// and the SQL under test are real; the ClickHouse module is mocked only to add that prefix and to pin
// `prefer_column_name_to_alias`.
//
// Pinned per query, to 0 and to 1, because the setting changes how an alias that shares a column's name resolves
// (0 resolves to the alias, which is what made `WHERE message = ...` read `any(message)`), a server profile can set
// it either way, and a query that depends on it breaks when the profile changes.

const realClickHouse = await import("../db/clickhouse");
const realClient = realClickHouse.getClickHouseClient();
let shadowTables = "";
let aliasSetting: 0 | 1 = 0;
mock.module("../db/clickhouse", () => ({
  ...realClickHouse,
  getClickHouseClient: () => ({
    query: (options: { query: string; clickhouse_settings?: ClickHouseSettings }) =>
      realClient.query(
        shadowTables
          ? {
              ...options,
              query: `WITH ${shadowTables} ${options.query}`,
              clickhouse_settings: { ...options.clickhouse_settings, prefer_column_name_to_alias: aliasSetting },
            }
          : options,
      ),
  }),
}));
const { apiRouter, queryAffectedUsers, queryDuplicateIssueGroups, queryEventNavigation, queryGroupStats } = await import("./api");

afterAll(() => {
  shadowTables = "";
});

const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;

// Event times are SQL, not JS: ClickHouse evaluates `now()` once per query, so the rows and the query's own
// windows share one clock and a test cannot straddle a window edge because the two clocks disagree.
const ago = (interval: string) => `toDateTime64(now('UTC') - INTERVAL ${interval}, 3, 'UTC')`;
const at = (utc: string) => `toDateTime64('${utc}', 3, 'UTC')`;

interface TestEvent {
  project: string;
  group: string;
  event?: string;
  at?: string;
  user?: string;
  message?: string;
  title?: string;
  release?: string;
}

let eventCounter = 0;

// The columns of backend/src/migrations/clickhouse/001_initial.sql and 002_user_identity.sql that any query under
// test reads, filled the way insertEvents in ingest-buffer.ts fills a missing value: an empty string.
function shadow(events: TestEvent[]) {
  const selects = events.map((event) => {
    const values: Record<string, string> = {
      event_id: literal(event.event ?? `e${(eventCounter += 1)}`),
      project_id: literal(event.project),
      group_id: literal(event.group),
      fingerprint: literal(event.group),
      title: literal(event.title ?? `Error: ${event.message ?? "boom"}`),
      message: literal(event.message ?? "boom"),
      severity: "'error'",
      release: literal(event.release ?? ""),
      environment: "'production'",
      user_id: literal(event.user ?? ""),
      user_email: "''",
      user_username: "''",
      browser: "'Chrome'",
      device: "''",
      os: "''",
      runtime: "''",
      tags: "'{}'",
      contexts: "'{}'",
      exception: "'{}'",
      stacktrace: "'{}'",
      raw_payload: "'{}'",
      timestamp: event.at ?? ago("1 MINUTE"),
    };
    return `SELECT ${Object.entries(values).map(([column, value]) => `${value} AS ${column}`).join(", ")}`;
  });
  // breadcrumbs is shadowed empty so the detail route's read of it cannot reach a real table either.
  const noBreadcrumbs = `breadcrumbs AS (SELECT '' AS event_id, '' AS project_id, '' AS group_id, now64(3, 'UTC') AS timestamp, '' AS category, '' AS level, '' AS message, '' AS type, '' AS data WHERE 0)`;
  shadowTables = `events AS (${selects.join(" UNION ALL ")}), ${noBreadcrumbs}`;
}

// The routes need a session, which lives in Redis and is set by sessionMiddleware in index.ts. The tests mount the
// real apiRouter on a small app whose middleware puts the chosen auth on the context, the same key requireAuth
// reads, and maps HttpError to its status like the app's onError does. Everything past auth is the real handler.
type Role = "admin" | "manager" | "viewer";
function appAs(role: Role, memberships: string[] = []) {
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
  app.onError((error, ctx) => (error instanceof HttpError ? ctx.json({ message: error.message }, error.status as 400 | 401 | 403 | 404) : ctx.json({ message: "Internal server error" }, 500)));
  app.route("/api", apiRouter);
  return app;
}

// SQLite side of the detail route: a project row (issue_workflows references projects) and one closed and one
// reopened issue. Removed in afterAll.
const routeSuffix = Math.random().toString(36).slice(2, 8);
const routeProject = `p_route_${routeSuffix}`;
const routeNow = new Date().toISOString();
const closedAt = "2026-11-13T07:30:00.000Z";
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [routeProject, `Route ${routeSuffix}`, `route-${routeSuffix}`, "production", 1, routeNow, routeNow]);
run(`INSERT INTO issue_workflows (project_id, group_id, state, assigned_user_id, created_at, updated_at, closed_at) VALUES (?, 'closed-group', 'closed', NULL, ?, ?, ?)`, [routeProject, routeNow, routeNow, closedAt]);
run(`INSERT INTO issue_workflows (project_id, group_id, state, assigned_user_id, created_at, updated_at, closed_at) VALUES (?, 'reopened-group', 'reopened', NULL, ?, ?, NULL)`, [routeProject, routeNow, routeNow]);
// Source map rows for the ingest-status route. The release the tests' newest event runs is r_new, which holds two
// maps and a bundle; r_old is older; r_unsent is the newest upload but no event runs it yet; one row belongs to
// another org and one to another project, both newer. The files are never opened, so the paths point nowhere.
const otherProject = `p_route_other_${routeSuffix}`;
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [otherProject, `Other ${routeSuffix}`, `other-${routeSuffix}`, "production", 1, routeNow, routeNow]);
let artifactCounter = 0;
const addArtifact = (projectId: string, release: string, artifactName: string, uploadedAt: string, org = config.EKEEPER_ORG) =>
  run(
    `INSERT INTO minimap_artifacts (id, org, project_id, project, release, dist, artifact_name, checksum, file_path, content_type, size, uploaded_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'c', ?, NULL, 1, ?, '2099-01-01T00:00:00.000Z')`,
    [`a_${routeSuffix}_${(artifactCounter += 1)}`, org, projectId, `slug-${projectId}`, release, artifactName, `/nonexistent/${artifactName}`, uploadedAt],
  );
addArtifact(routeProject, "r_old", "~/assets/a.js.map", "2026-11-01T00:00:00.000Z");
addArtifact(routeProject, "r_old", "~/assets/b.js.map", "2026-11-01T00:00:01.000Z");
addArtifact(routeProject, "r_new", "~/assets/a.js", "2026-11-12T00:00:00.000Z");
addArtifact(routeProject, "r_new", "~/assets/a.js.map", "2026-11-12T00:00:01.000Z");
addArtifact(routeProject, "r_new", "~/assets/b.js.map", "2026-11-12T00:00:02.000Z");
addArtifact(routeProject, "r_unsent", "~/assets/a.js.map", "2026-11-13T00:00:00.000Z");
addArtifact(routeProject, "r_other_org", "~/assets/a.js.map", "2026-11-13T00:00:00.000Z", "someone-else");
addArtifact(otherProject, "r_other_project", "~/assets/a.js.map", "2026-11-13T00:00:00.000Z");
afterAll(() => {
  run(`DELETE FROM minimap_artifacts WHERE project_id IN (?, ?)`, [routeProject, otherProject]);
  run(`DELETE FROM issue_workflows WHERE project_id = ?`, [routeProject]);
  run(`DELETE FROM projects WHERE id IN (?, ?)`, [routeProject, otherProject]);
});

describe("queryAffectedUsers", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  test("counts distinct non-empty users of the group: the same user twice is one, an event with no user is none", async () => {
    shadow([
      { project: "pA", group: "g1", user: "u1" },
      { project: "pA", group: "g1", user: "u1" },
      { project: "pA", group: "g1", user: "" },
      { project: "pA", group: "g1", user: "u2" },
    ]);

    expect(await queryAffectedUsers([{ projectId: "pA", groupId: "g1" }])).toBe(2);
  });

  test("does not count another group, or the same group id in another project", async () => {
    shadow([
      { project: "pA", group: "g1", user: "u1" },
      { project: "pA", group: "g2", user: "u2" },
      { project: "pB", group: "g1", user: "u3" },
    ]);

    expect(await queryAffectedUsers([{ projectId: "pA", groupId: "g1" }])).toBe(1);
  });

  test("an unknown group has 0 users, and an empty list is 0 without a query", async () => {
    shadow([{ project: "pA", group: "g1", user: "u1" }]);

    expect(await queryAffectedUsers([{ projectId: "pA", groupId: "nope" }])).toBe(0);
    shadowTables = "events AS (SELECT throwIf(1) AS event_id)";
    expect(await queryAffectedUsers([])).toBe(0);
  });

  test("counts a user once across several groups: per group counts cannot be summed", async () => {
    shadow([
      { project: "pA", group: "g1", user: "shared" },
      { project: "pA", group: "g1", user: "only1" },
      { project: "pA", group: "g2", user: "shared" },
      { project: "pB", group: "g1", user: "shared" },
      { project: "pB", group: "g9", user: "not-asked" },
    ]);

    const groups = [{ projectId: "pA", groupId: "g1" }, { projectId: "pA", groupId: "g2" }, { projectId: "pB", groupId: "g1" }];
    expect(await queryAffectedUsers(groups)).toBe(2);
  });

  test("group ids and user ids with quotes, backslashes, commas, brackets and newlines are matched literally, not parsed", async () => {
    const hostile = `a'b\\c,d)]\n"e`;
    shadow([
      { project: "pA", group: hostile, user: hostile },
      { project: "pA", group: "plain", user: "u" },
      { project: "pA", group: `a'b`, user: "other" },
    ]);

    expect(await queryAffectedUsers([{ projectId: "pA", groupId: hostile }])).toBe(1);
    expect(await queryAffectedUsers([{ projectId: "pA", groupId: "a'b" }])).toBe(1);
  });

  test("500 groups in one call, the most a request may carry", async () => {
    const groups = Array.from({ length: 500 }, (_, index) => ({ projectId: "pA", groupId: `group-${index}` }));
    shadow(groups.map((group, index) => ({ project: group.projectId, group: group.groupId, user: `user-${index % 40}` })));

    expect(await queryAffectedUsers(groups)).toBe(40);
  });
});

describe("queryGroupStats", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  // Rolling hours: hourly24h[i] is [now - (24 - i)h, now - (23 - i)h). Each lower edge is inclusive, so an event
  // exactly 1 hour old is in the last bar and one exactly 24 hours old is in the first. `ago` is evaluated by the
  // same query's now(), so the edge events sit exactly on the edges.
  const group = "g1";
  const inWindow: TestEvent[] = [
    { project: "pA", group, at: ago("30 MINUTE") },
    { project: "pA", group, at: ago("30 MINUTE") },
    { project: "pA", group, at: ago("1 HOUR") },
    { project: "pA", group, at: ago("-3 HOUR") },
    { project: "pA", group, at: ago("61 MINUTE") },
    { project: "pA", group, at: ago("2 HOUR") },
    { project: "pA", group, at: ago("330 MINUTE") },
    { project: "pA", group, at: ago("1410 MINUTE") },
    { project: "pA", group, at: ago("24 HOUR") },
    { project: "pA", group, at: ago("86399999 MILLISECOND") },
    { project: "pA", group, at: ago("0 SECOND") },
  ];
  const outside: TestEvent[] = [
    { project: "pA", group, at: ago("86400001 MILLISECOND") },
    { project: "pA", group, at: ago("86401 SECOND") },
    { project: "pA", group, at: ago("3 DAY") },
    { project: "pA", group, at: ago("8 DAY") },
    { project: "pA", group: "other", at: ago("30 MINUTE") },
    { project: "pB", group, at: ago("30 MINUTE") },
  ];

  test("24 counts, oldest first, rolling hours with inclusive lower edges, for this group only", async () => {
    shadow([...inWindow, ...outside]);

    const stats = await queryGroupStats("pA", group);

    const expected = new Array<number>(24).fill(0);
    expected[23] = 5; // 30 min x2, exactly 1 h, exactly now, and the event stamped 3 h ahead of the clock
    expected[22] = 2; // 61 min and exactly 2 h
    expected[18] = 1; // 5 h 30 min
    expected[0] = 3; // 23 h 30 min, exactly 24 h, and 1 ms newer than 24 h (an event 1 ms older is outside)
    expect(stats.hourly24h).toEqual(expected);
  });

  test("the chart sums to events24h: one now() for both, so an event on a bucket edge is counted once in each", async () => {
    shadow([...inWindow, ...outside]);

    const stats = await queryGroupStats("pA", group);

    expect(stats.hourly24h.reduce((sum, count) => sum + count, 0)).toBe(stats.events24h);
    expect(stats.events24h).toBe(11);
  });

  test("an event one second older than 24 hours is in no bar and not in events24h, but is in the 7 day count and the total", async () => {
    shadow([{ project: "pA", group, at: ago("86401 SECOND") }]);

    const stats = await queryGroupStats("pA", group);

    expect(stats).toMatchObject({ events24h: 0, events7d: 1, totalEvents: 1 });
    expect(stats.hourly24h.every((count) => count === 0)).toBe(true);
  });

  test("the total, 24h and 7d counts are for this group, and the 7 day window is rolling", async () => {
    shadow([...inWindow, ...outside]);

    const stats = await queryGroupStats("pA", group);

    expect(stats.totalEvents).toBe(15);
    expect(stats.events24h).toBe(11);
    // the 11 in the last 24 hours, the ones 24 h 1 ms and 24 h 1 s old, and the one 3 days old; not the one 8 days old
    expect(stats.events7d).toBe(14);
  });

  test("firstSeen and lastSeen are ISO 8601 UTC with Z, not zoneless digits", async () => {
    shadow([
      { project: "pA", group, at: at("2020-06-07 08:09:10.111") },
      { project: "pA", group, at: at("2020-01-02 03:04:05.678") },
      { project: "pA", group, at: at("2020-03-04 05:06:07.001") },
    ]);

    const stats = await queryGroupStats("pA", group);

    expect(stats.firstSeen).toBe("2020-01-02T03:04:05.678Z");
    expect(stats.lastSeen).toBe("2020-06-07T08:09:10.111Z");
    expect(stats.hourly24h.every((count) => count === 0)).toBe(true);
  });

  test("an unknown group is all zeros and null times, not an error and not 1970", async () => {
    shadow([{ project: "pA", group, at: ago("30 MINUTE") }]);

    expect(await queryGroupStats("pA", "nope")).toEqual({
      totalEvents: 0,
      events24h: 0,
      events7d: 0,
      hourly24h: new Array<number>(24).fill(0),
      firstSeen: null,
      lastSeen: null,
    });
  });
});

describe("queryEventNavigation", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  // Newest first: e5, e4, e3, e2, e1. e3 and e4 share a millisecond, so their order is decided by event_id.
  const events: TestEvent[] = [
    { project: "pA", group: "g1", event: "e1", at: at("2020-01-01 00:00:00.000") },
    { project: "pA", group: "g1", event: "e2", at: at("2020-01-02 00:00:00.000") },
    { project: "pA", group: "g1", event: "e3", at: at("2020-01-03 00:00:00.500") },
    { project: "pA", group: "g1", event: "e4", at: at("2020-01-03 00:00:00.500") },
    { project: "pA", group: "g1", event: "e5", at: at("2020-01-04 00:00:00.000") },
    { project: "pA", group: "other", event: "x1", at: at("2020-01-05 00:00:00.000") },
    { project: "pB", group: "g1", event: "y1", at: at("2020-01-06 00:00:00.000") },
  ];
  const times: Record<string, string> = {
    e1: "2020-01-01 00:00:00.000",
    e2: "2020-01-02 00:00:00.000",
    e3: "2020-01-03 00:00:00.500",
    e4: "2020-01-03 00:00:00.500",
    e5: "2020-01-04 00:00:00.000",
  };
  const navigate = (eventId: string) => queryEventNavigation("pA", "g1", { eventId, timestamp: times[eventId]! });

  test("the middle of the group: both neighbours, the group's newest and oldest, position from the newest", async () => {
    shadow(events);

    expect(await navigate("e2")).toEqual({ latestEventId: "e5", oldestEventId: "e1", newerEventId: "e3", olderEventId: "e1", position: 4, total: 5 });
  });

  test("the newest event: nothing newer, position 1, and Latest is itself", async () => {
    shadow(events);

    expect(await navigate("e5")).toEqual({ latestEventId: "e5", oldestEventId: "e1", newerEventId: null, olderEventId: "e4", position: 1, total: 5 });
  });

  test("the oldest event: nothing older, position equals the total, and Oldest is itself", async () => {
    shadow(events);

    expect(await navigate("e1")).toEqual({ latestEventId: "e5", oldestEventId: "e1", newerEventId: "e2", olderEventId: null, position: 5, total: 5 });
  });

  test("two events in the same millisecond are ordered by event_id: each is the other's neighbour, never both or neither", async () => {
    shadow(events);

    expect(await navigate("e3")).toMatchObject({ newerEventId: "e4", olderEventId: "e2", position: 3 });
    expect(await navigate("e4")).toMatchObject({ newerEventId: "e5", olderEventId: "e3", position: 2 });
  });

  test("a group with one event has no neighbours and is position 1 of 1", async () => {
    shadow([{ project: "pA", group: "g1", event: "only", at: at("2020-01-01 00:00:00.000") }]);

    expect(await queryEventNavigation("pA", "g1", { eventId: "only", timestamp: "2020-01-01 00:00:00.000" })).toEqual({
      latestEventId: "only",
      oldestEventId: "only",
      newerEventId: null,
      olderEventId: null,
      position: 1,
      total: 1,
    });
  });

  test("walking Older from the newest visits every event once and ends at the oldest, so no event is skipped or repeated", async () => {
    shadow(events);

    const visited: string[] = [];
    let current: string | null = "e5";
    while (current) {
      visited.push(current);
      current = (await navigate(current)).olderEventId;
    }

    expect(visited).toEqual(["e5", "e4", "e3", "e2", "e1"]);
  });
});

describe.each([0, 1] as const)("queryDuplicateIssueGroups with prefer_column_name_to_alias = %d", (setting) => {
  beforeEach(() => {
    aliasSetting = setting;
  });

  const current = { project: "pA", group: "current", message: "Cannot read properties of undefined" };

  test("returns the other groups with the same message, with events, users, release and times", async () => {
    shadow([
      { ...current, user: "u1" },
      { project: "pA", group: "twin1", message: current.message, title: "TypeError: twin one", user: "u1", release: "2026.11.12-1", at: ago("3 HOUR") },
      { project: "pA", group: "twin1", message: current.message, title: "TypeError: twin one", user: "u2", release: "2026.11.13-1", at: ago("1 HOUR") },
      { project: "pA", group: "twin1", message: current.message, user: "u2", release: "2026.11.13-1", at: ago("2 HOUR") },
      { project: "pA", group: "twin2", message: current.message, user: "", release: "2026.11.10-1", at: ago("5 HOUR") },
      { project: "pA", group: "unrelated", message: "something else entirely" },
    ]);

    const result = await queryDuplicateIssueGroups("pA", "current", current.message);

    expect(result.map((group) => group.groupId)).toEqual(["twin1", "twin2"]);
    expect(result[0]).toMatchObject({
      groupId: "twin1",
      message: current.message,
      fingerprint: "twin1",
      events: 3,
      affectedUsers: 2,
      latestRelease: "2026.11.13-1",
    });
    expect(result[0]!.title).toContain("Error");
    expect(result[1]).toMatchObject({ groupId: "twin2", events: 1, affectedUsers: 0, latestRelease: "2026.11.10-1" });
    expect(typeof result[0]!.firstSeen).toBe("string");
    expect(result[0]!.firstSeen < result[0]!.lastSeen).toBe(true);
  });

  test("never returns the current group, or a group of another project", async () => {
    shadow([
      { ...current },
      { project: "pB", group: "other-project-twin", message: current.message },
      { project: "pA", group: "twin", message: current.message },
    ]);

    const result = await queryDuplicateIssueGroups("pA", "current", current.message);

    expect(result.map((group) => group.groupId)).toEqual(["twin"]);
  });

  test("ignores an event older than 90 days, and keeps one just inside", async () => {
    shadow([
      { project: "pA", group: "old", message: current.message, at: ago("91 DAY") },
      { project: "pA", group: "recent", message: current.message, at: ago("89 DAY") },
    ]);

    const result = await queryDuplicateIssueGroups("pA", "current", current.message);

    expect(result.map((group) => group.groupId)).toEqual(["recent"]);
  });

  test("a latest event with no release gives null, not an empty string", async () => {
    shadow([{ project: "pA", group: "twin", message: current.message, release: "" }]);

    const [group] = await queryDuplicateIssueGroups("pA", "current", current.message);

    expect(group!.latestRelease).toBeNull();
  });

  test("finds a group whose message differs only in a URL query or an id, through the LIKE prefix", async () => {
    const message = "fetch failed https://api.example.com/v1/slots?id=1";
    shadow([
      { project: "pA", group: "twin", message: "fetch failed https://api.example.com/v1/slots?id=2" },
      { project: "pA", group: "different", message: "fetch failed https://api.example.com/v1/other" },
    ]);

    const result = await queryDuplicateIssueGroups("pA", "current", message);

    expect(result.map((group) => group.groupId)).toEqual(["twin"]);
  });

  test("a message that normalizes to nothing asks ClickHouse nothing and returns no groups", async () => {
    shadowTables = "events AS (SELECT throwIf(1) AS event_id)";

    expect(await queryDuplicateIssueGroups("pA", "current", "")).toEqual([]);
  });

  test("at most 12 groups come back, the busiest first", async () => {
    shadow(
      Array.from({ length: 15 }, (_, group) =>
        Array.from({ length: group + 1 }, () => ({ project: "pA", group: `twin${String(group).padStart(2, "0")}`, message: current.message })),
      ).flat(),
    );

    const result = await queryDuplicateIssueGroups("pA", "current", current.message);

    expect(result).toHaveLength(12);
    expect(result[0]!.groupId).toBe("twin14");
    expect(result[0]!.events).toBe(15);
  });
});

describe("GET /api/projects/:projectId/errors/:groupId", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  const detail = async (path: string, app = appAs("admin")) => {
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as ErrorDetailResponse & { occurrences?: unknown } };
  };
  const seed = () =>
    shadow([
      { project: routeProject, group: "g1", event: "e1", user: "u1", at: at("2020-01-01 00:00:00.000"), release: "r1" },
      { project: routeProject, group: "g1", event: "e2", user: "u1", at: at("2020-01-02 00:00:00.000"), release: "r1" },
      { project: routeProject, group: "g1", event: "e3", user: "u2", at: at("2020-01-03 00:00:00.000"), release: "r2" },
      { project: routeProject, group: "g1", event: "e4", user: "", at: at("2020-01-03 00:00:00.000"), release: "r2" },
      { project: routeProject, group: "twin", user: "u1", message: "boom", at: ago("2 HOUR"), release: "r3" },
    ]);

  test("answers error, stats, navigation and duplicateGroups, and no occurrences list", async () => {
    seed();

    const { status, body } = await detail(`/api/projects/${routeProject}/errors/g1`);

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["duplicateGroups", "error", "navigation", "stats"]);
    expect(body.error).toMatchObject({ eventId: "e4", groupId: "g1", affectedUsers: 2, closedAt: null, state: "open", projectId: routeProject });
    expect(body.stats).toMatchObject({ totalEvents: 4, firstSeen: "2020-01-01T00:00:00.000Z", lastSeen: "2020-01-03T00:00:00.000Z" });
    expect(body.stats.hourly24h).toHaveLength(24);
    expect(body.navigation).toEqual({ latestEventId: "e4", oldestEventId: "e1", newerEventId: null, olderEventId: "e3", position: 1, total: 4 });
    expect(body.duplicateGroups.map((group) => [group.groupId, group.events, group.latestRelease])).toEqual([["twin", 1, "r3"]]);
  });

  test("?eventId shows that event and navigates from it", async () => {
    seed();

    const { body } = await detail(`/api/projects/${routeProject}/errors/g1?eventId=e2`);

    expect(body.error?.eventId).toBe("e2");
    expect(body.navigation).toEqual({ latestEventId: "e4", oldestEventId: "e1", newerEventId: "e3", olderEventId: "e1", position: 3, total: 4 });
    expect(body.stats.totalEvents).toBe(4);
  });

  test("an unknown event id on a known group has no event and no navigation, but the group's stats", async () => {
    seed();

    const { status, body } = await detail(`/api/projects/${routeProject}/errors/g1?eventId=missing`);

    expect(status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.navigation).toBeNull();
    expect(body.stats.totalEvents).toBe(4);
    expect(body.duplicateGroups).toEqual([]);
  });

  test("an unknown group is 200 with error null, navigation null and zero stats", async () => {
    seed();

    const { status, body } = await detail(`/api/projects/${routeProject}/errors/nope`);

    expect(status).toBe(200);
    expect(body).toEqual({
      error: null,
      stats: { totalEvents: 0, events24h: 0, events7d: 0, hourly24h: new Array<number>(24).fill(0), firstSeen: null, lastSeen: null },
      navigation: null,
      duplicateGroups: [],
    });
  });

  test("a closed issue carries closedAt as stored, a reopened or never closed one carries null", async () => {
    shadow([
      { project: routeProject, group: "closed-group", user: "u1" },
      { project: routeProject, group: "reopened-group", user: "u1" },
    ]);

    const closed = await detail(`/api/projects/${routeProject}/errors/closed-group`);
    const reopened = await detail(`/api/projects/${routeProject}/errors/reopened-group`);

    expect(closed.body.error).toMatchObject({ state: "closed", closedAt });
    expect(reopened.body.error).toMatchObject({ state: "reopened", closedAt: null });
  });

  test("project access: a manager without a membership is refused, one with it and a viewer read", async () => {
    seed();
    const path = `/api/projects/${routeProject}/errors/g1`;

    expect((await detail(path, appAs("manager"))).status).toBe(403);
    expect((await detail(path, appAs("manager", [routeProject]))).status).toBe(200);
    expect((await detail(path, appAs("viewer"))).status).toBe(200);
  });
});

describe("POST /api/errors/affected-users", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  // A query that reaches ClickHouse while this is set fails with a 500, so a 4xx proves the request was refused
  // before any query ran.
  const noQueryMayRun = () => {
    shadowTables = "events AS (SELECT throwIf(1) AS event_id)";
  };
  const post = (body: unknown, app = appAs("admin")) =>
    app.request("/api/errors/affected-users", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const group = (projectId: string, groupId: string) => ({ projectId, groupId });

  test("counts a user once across the listed groups of several projects", async () => {
    shadow([
      { project: "pA", group: "g1", user: "shared" },
      { project: "pA", group: "g1", user: "only1" },
      { project: "pA", group: "g2", user: "shared" },
      { project: "pB", group: "g1", user: "shared" },
      { project: "pB", group: "not-listed", user: "not-asked" },
    ]);

    const response = await post({ groups: [group("pA", "g1"), group("pA", "g2"), group("pB", "g1")] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ affectedUsers: 2 });
  });

  test("no groups is 0 and asks ClickHouse nothing", async () => {
    noQueryMayRun();

    const response = await post({ groups: [] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ affectedUsers: 0 });
  });

  test("500 groups are accepted, 501 are refused", async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => group("pA", `g${index}`));
    shadow(many(500).map((entry, index) => ({ project: entry.projectId, group: entry.groupId, user: `u${index % 7}` })));

    const ok = await post({ groups: many(500) });
    noQueryMayRun();
    const tooMany = await post({ groups: many(501) });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ affectedUsers: 7 });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { message: string }).message).toContain("groups");
  });

  // ClickHouse refuses a query parameter over 131072 URL encoded bytes, and the pairs are one parameter
  // (clickhouse-params.ts). The two lengths below straddle the 100,000 byte budget; a 40 character project id is
  // what createId("project") makes, and 200 characters is the longest id the S4 allowlist keeps verbatim.
  test("500 pairs of 40 character project ids and 130 character group ids are served by the engine end to end", async () => {
    const groups = Array.from({ length: 500 }, (_, index) => group(`project_${index}`.padEnd(40, "p"), `legacy-${index}`.padEnd(130, "g")));
    // Only 9 of the 500 groups have events: ClickHouse caps the query text at max_query_size (262144 bytes), which
    // 500 shadow rows of every column would pass; the long parameter is the point of this test, not the table.
    shadow(groups.slice(0, 9).map((entry, index) => ({ project: entry.projectId, group: entry.groupId, user: `u${index}` })));

    const response = await post({ groups });

    expect([response.status, await response.json()]).toEqual([200, { affectedUsers: 9 }]);
  });

  test("500 pairs of 40 character project ids and 200 character group ids are a 400 before any query, not the engine's 500", async () => {
    noQueryMayRun();
    const groups = Array.from({ length: 500 }, (_, index) => group(`project_${index}`.padEnd(40, "p"), `legacy-${index}`.padEnd(200, "g")));

    const response = await post({ groups });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain("too long");
  });

  test("500 pairs of the 40 and 32 character ids a real list has are served", async () => {
    const groups = Array.from({ length: 500 }, (_, index) => group(`project_${index}`.padEnd(40, "p"), `${index}`.padStart(32, "0")));
    shadow(groups.slice(0, 4).map((entry, index) => ({ project: entry.projectId, group: entry.groupId, user: `u${index}` })));

    const response = await post({ groups });

    expect([response.status, await response.json()]).toEqual([200, { affectedUsers: 4 }]);
  });

  test("a body that is not the schema is a 400 before any query: not JSON, no groups, wrong types, empty ids", async () => {
    noQueryMayRun();
    const bodies: unknown[] = [
      "not json",
      "",
      {},
      { groups: "x" },
      { groups: null },
      [],
      { groups: [{ projectId: "pA" }] },
      { groups: [{ groupId: "g1" }] },
      { groups: [{ projectId: "", groupId: "g1" }] },
      { groups: [{ projectId: "pA", groupId: "" }] },
      { groups: [{ projectId: 1, groupId: "g1" }] },
      { groups: [{ projectId: "pA", groupId: ["g1"] }] },
      { groups: [null] },
      { groups: [{ projectId: "pA", groupId: "x".repeat(4097) }] },
    ];

    for (const body of bodies) {
      const response = await post(body);
      expect([response.status, JSON.stringify(body)]).toEqual([400, JSON.stringify(body)]);
    }
  });

  test("every project named must be readable: one the caller cannot read refuses the whole request, before any query", async () => {
    noQueryMayRun();
    const groups = [group("pA", "g1"), group("pB", "g1")];

    const refused = await post({ groups }, appAs("manager", ["pA"]));

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ message: "Project access denied" });
  });

  test("a manager with a membership in every project named, a workspace viewer and an admin are served", async () => {
    shadow([{ project: "pA", group: "g1", user: "u1" }, { project: "pB", group: "g1", user: "u2" }]);
    const body = { groups: [group("pA", "g1"), group("pB", "g1")] };

    for (const app of [appAs("manager", ["pA", "pB"]), appAs("viewer"), appAs("admin")]) {
      const response = await post(body, app);
      expect([response.status, await response.json()]).toEqual([200, { affectedUsers: 2 }]);
    }
  });

  test("without a session it is 401", async () => {
    noQueryMayRun();
    const app = new Hono();
    app.onError((error, ctx) => (error instanceof HttpError ? ctx.json({ message: error.message }, error.status as 401) : ctx.json({}, 500)));
    app.route("/api", apiRouter);

    const response = await post({ groups: [] }, app);

    expect(response.status).toBe(401);
  });
});

describe("GET /api/projects/:projectId/ingest-status", () => {
  beforeEach(() => {
    aliasSetting = 0;
  });

  const status = async (projectId: string, app = appAs("admin")) => {
    const response = await app.request(`/api/projects/${projectId}/ingest-status`);
    return { status: response.status, body: await response.json() };
  };
  const withProject = async (suffixName: string, run_: (projectId: string) => Promise<void>) => {
    const projectId = `p_${suffixName}_${routeSuffix}`;
    run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [projectId, `${suffixName} ${routeSuffix}`, `${suffixName}-${routeSuffix}`, "production", 1, routeNow, routeNow]);
    try {
      await run_(projectId);
    } finally {
      run(`DELETE FROM minimap_artifacts WHERE project_id = ?`, [projectId]);
      run(`DELETE FROM projects WHERE id = ?`, [projectId]);
    }
  };

  test("the newest event's time as ISO with Z, its release, and the map files of exactly that release", async () => {
    shadow([
      { project: routeProject, group: "g1", at: at("2026-11-13 10:31:00.250"), release: "r_new" },
      { project: routeProject, group: "g1", at: at("2026-11-12 09:00:00.000"), release: "r_old" },
      { project: otherProject, group: "g1", at: at("2026-11-14 00:00:00.000"), release: "r_other_project" },
    ]);

    expect(await status(routeProject)).toEqual({
      status: 200,
      body: { lastEventAt: "2026-11-13T10:31:00.250Z", latestRelease: "r_new", sourceMapFiles: 2 },
    });
  });

  test("the release is the newest event's, not the newest upload: maps uploaded by a build that has sent no event are not counted", async () => {
    shadow([{ project: routeProject, group: "g1", at: at("2026-11-13 10:31:00.250"), release: "r_old" }]);

    expect((await status(routeProject)).body).toMatchObject({ latestRelease: "r_old", sourceMapFiles: 2 });
  });

  test("a release with an event but no uploaded maps is reported with 0 files", async () => {
    shadow([{ project: routeProject, group: "g1", release: "r_never_uploaded" }]);

    expect((await status(routeProject)).body).toMatchObject({ latestRelease: "r_never_uploaded", sourceMapFiles: 0 });
  });

  test("a newest event with no release has a null release and 0 files, whatever was uploaded", async () => {
    shadow([
      { project: routeProject, group: "g1", at: at("2026-11-13 10:31:00.250"), release: "" },
      { project: routeProject, group: "g1", at: at("2026-11-12 09:00:00.000"), release: "r_new" },
    ]);

    expect(await status(routeProject)).toEqual({ status: 200, body: { lastEventAt: "2026-11-13T10:31:00.250Z", latestRelease: null, sourceMapFiles: 0 } });
  });

  test("a project with no event answers nulls and 0 even when it has uploads, not an error", async () => {
    shadow([{ project: "someone-else", group: "g1" }]);

    expect(await status(routeProject)).toEqual({ status: 200, body: { lastEventAt: null, latestRelease: null, sourceMapFiles: 0 } });
  });

  test("a release that holds only bundles is reported with 0 map files", async () => {
    await withProject("bundles", async (projectId) => {
      addArtifact(projectId, "r_bundles", "~/assets/a.js", "2026-11-12T00:00:00.000Z");
      shadow([{ project: projectId, group: "g1", release: "r_bundles" }]);

      expect((await status(projectId)).body).toMatchObject({ latestRelease: "r_bundles", sourceMapFiles: 0 });
    });
  });

  test("a release with surrounding spaces counts the files stored under the trimmed name, as a source map lookup does", async () => {
    shadow([{ project: routeProject, group: "g1", release: " r_new " }]);

    expect((await status(routeProject)).body).toMatchObject({ sourceMapFiles: 2 });
  });

  test("project access: a manager without a membership is refused, one with it and a viewer read", async () => {
    shadow([{ project: routeProject, group: "g1" }]);

    expect((await status(routeProject, appAs("manager"))).status).toBe(403);
    expect((await status(routeProject, appAs("manager", [routeProject]))).status).toBe(200);
    expect((await status(routeProject, appAs("viewer"))).status).toBe(200);
  });
});
