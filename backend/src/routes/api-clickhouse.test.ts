import type { ClickHouseSettings } from "@clickhouse/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { ErrorDetailResponse } from "@ekeeper/shared";
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
let sessionTimezone: string | undefined;
mock.module("../db/clickhouse", () => ({
  ...realClickHouse,
  getClickHouseClient: () => ({
    query: (options: { query: string; clickhouse_settings?: ClickHouseSettings }) =>
      realClient.query(
        shadowTables
          ? {
              ...options,
              query: `WITH ${shadowTables} ${options.query}`,
              clickhouse_settings: {
                ...options.clickhouse_settings,
                prefer_column_name_to_alias: aliasSetting,
                ...(sessionTimezone ? { session_timezone: sessionTimezone } : {}),
              },
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
// The start of the UTC clock hour `hours` ago: the exact edge a bucket is cut at.
const hourStart = (hours: number) => `toDateTime64(toStartOfHour(now('UTC'), 'UTC') - INTERVAL ${hours} HOUR, 3, 'UTC')`;
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
afterAll(() => {
  run(`DELETE FROM issue_workflows WHERE project_id = ?`, [routeProject]);
  run(`DELETE FROM projects WHERE id = ?`, [routeProject]);
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
    sessionTimezone = undefined;
  });

  // One event on each edge of the 24 hour window, plus the hour just outside it: the first event of the current
  // UTC hour is entry 23, and 23 hours earlier is entry 0.
  const edgeEvents: TestEvent[] = [
    { project: "pA", group: "g1", at: hourStart(0) },
    { project: "pA", group: "g1", at: hourStart(0) },
    { project: "pA", group: "g1", at: hourStart(1) },
    { project: "pA", group: "g1", at: hourStart(5) },
    { project: "pA", group: "g1", at: hourStart(23) },
    { project: "pA", group: "g1", at: ago("1441 MINUTE") },
    { project: "pA", group: "g1", at: ago("3 DAY") },
    { project: "pA", group: "g1", at: ago("8 DAY") },
    { project: "pA", group: "other", at: hourStart(0) },
    { project: "pB", group: "g1", at: hourStart(0) },
  ];

  test("24 counts, oldest first, one per UTC clock hour, zero filled, for this group only", async () => {
    shadow(edgeEvents);

    const stats = await queryGroupStats("pA", "g1");

    expect(stats.hourly24h).toHaveLength(24);
    const expected = new Array<number>(24).fill(0);
    expected[23] = 2;
    expected[22] = 1;
    expected[18] = 1;
    expected[0] = 1;
    expect(stats.hourly24h).toEqual(expected);
  });

  test("the hours are UTC clock hours whatever time zone the server session runs in", async () => {
    shadow(edgeEvents);
    sessionTimezone = "Asia/Kolkata";

    const stats = await queryGroupStats("pA", "g1");

    expect(stats.hourly24h[23]).toBe(2);
    expect(stats.hourly24h[22]).toBe(1);
    expect(stats.hourly24h[0]).toBe(1);
  });

  test("totals count every event of the group; the 24h and 7d windows are rolling and agree with the list's countIf", async () => {
    shadow(edgeEvents);

    const stats = await queryGroupStats("pA", "g1");

    expect(stats.totalEvents).toBe(8);
    // hourStart(23) is still inside a rolling day; 1441 minutes ago and older are not.
    expect(stats.events24h).toBe(5);
    expect(stats.events7d).toBe(7);
  });

  test("firstSeen and lastSeen are ISO 8601 UTC with Z, not zoneless digits", async () => {
    shadow([
      { project: "pA", group: "g1", at: at("2020-06-07 08:09:10.111") },
      { project: "pA", group: "g1", at: at("2020-01-02 03:04:05.678") },
      { project: "pA", group: "g1", at: at("2020-03-04 05:06:07.001") },
    ]);

    const stats = await queryGroupStats("pA", "g1");

    expect(stats.firstSeen).toBe("2020-01-02T03:04:05.678Z");
    expect(stats.lastSeen).toBe("2020-06-07T08:09:10.111Z");
    expect(stats.hourly24h.every((count) => count === 0)).toBe(true);
  });

  test("an unknown group is all zeros and null times, not an error and not 1970", async () => {
    shadow([{ project: "pA", group: "g1" }]);

    expect(await queryGroupStats("pA", "nope")).toEqual({
      totalEvents: 0,
      events24h: 0,
      events7d: 0,
      hourly24h: new Array<number>(24).fill(0),
      firstSeen: null,
      lastSeen: null,
    });
  });

  test("an event stamped ahead of the clock is counted in the totals but not drawn in a bar that does not exist yet", async () => {
    shadow([{ project: "pA", group: "g1", at: ago("-3 HOUR") }, { project: "pA", group: "g1", at: hourStart(0) }]);

    const stats = await queryGroupStats("pA", "g1");

    expect(stats.totalEvents).toBe(2);
    expect(stats.hourly24h.reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});

describe("queryEventNavigation", () => {
  beforeEach(() => {
    aliasSetting = 0;
    sessionTimezone = undefined;
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
    sessionTimezone = undefined;
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
