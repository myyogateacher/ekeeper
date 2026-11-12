import type { ClickHouseSettings } from "@clickhouse/client";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
          ? { ...options, query: `WITH ${shadowTables} ${options.query}`, clickhouse_settings: { ...options.clickhouse_settings, prefer_column_name_to_alias: aliasSetting } }
          : options,
      ),
  }),
}));
const { queryAffectedUsers } = await import("./api");

afterAll(() => {
  shadowTables = "";
});

const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;

// Event times are SQL, not JS: ClickHouse evaluates `now()` once per query, so the rows and the query's own
// windows share one clock and a test cannot straddle a window edge because the two clocks disagree.
const ago = (interval: string) => `toDateTime64(now('UTC') - INTERVAL ${interval}, 3, 'UTC')`;

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
      timestamp: event.at ?? ago("1 MINUTE"),
    };
    return `SELECT ${Object.entries(values).map(([column, value]) => `${value} AS ${column}`).join(", ")}`;
  });
  shadowTables = `events AS (${selects.join(" UNION ALL ")})`;
}

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
