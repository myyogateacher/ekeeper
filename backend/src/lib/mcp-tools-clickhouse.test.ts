import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { SourceMapGenerator } from "source-map-js";
import { config } from "../config";
import { run } from "../db/sqlite";
import { normalizeEvent } from "./ingest";
import { saveMinimapArtifact } from "./minimaps";

// These tests run the real MCP handlers against a real ClickHouse, because SQL asserted as text proves
// nothing: the alias bug in top_issues parsed fine as a string and failed only in the engine (defect register
// entry 20, and ClickHouse resolves aliases differently across versions). They need CLICKHOUSE_URL reachable,
// the same way the oauth tests need Redis. They write nothing to ClickHouse: each query is prefixed with
// `WITH events AS (<rows below>), breadcrumbs AS (...)`, which shadows the real tables for that one query.
// They do write one project row and one minimap row to the configured SQLite and one source map file under
// MINIMAPS_STORAGE_PATH (deobfuscateEvent reads all three), and afterAll removes them.
// The ClickHouse module is mocked only to add that prefix; the handlers, `q` and the SQL under test are real.

const realClickHouse = await import("../db/clickhouse");
const realClient = realClickHouse.getClickHouseClient();
let shadowTables = "";
mock.module("../db/clickhouse", () => ({
  ...realClickHouse,
  getClickHouseClient: () => ({
    query: (options: { query: string }) =>
      realClient.query(shadowTables ? { ...options, query: `WITH ${shadowTables} ${options.query}` } : options),
  }),
}));
const { buildWhere, getTool } = await import("./mcp-tools");

const suffix = Math.random().toString(36).slice(2, 8);
const projectWeb = `p_web_${suffix}`;
const projectOther = `p_other_${suffix}`;
const now = new Date().toISOString();
// Events sit an hour in the past: buildWhere's upper bound is "now" parsed by parseDateTimeBestEffort, which
// drops the milliseconds, so an event stamped within the same second as the query would fall outside it.
const eventAt = new Date(Date.now() - 3_600_000).toISOString();

const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const chTime = (iso: string) => `toDateTime64(${literal(iso.replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;

// Column set and JSON encodings follow insertEvents in ingest-buffer.ts, built from the real normalizeEvent.
function eventRow(projectId: string, payload: Record<string, unknown>) {
  const event = normalizeEvent(projectId, { timestamp: eventAt, ...payload });
  return {
    event_id: event.eventId,
    project_id: event.projectId,
    group_id: event.groupId,
    fingerprint: event.fingerprint,
    title: event.title,
    message: event.message,
    severity: event.severity,
    release: event.release ?? "",
    environment: event.environment ?? "",
    user_id: event.userId ?? "",
    user_email: event.userEmail ?? "",
    user_username: event.userUsername ?? "",
    browser: event.browser ?? "",
    device: event.device ?? "",
    os: event.os ?? "",
    runtime: event.runtime ?? "",
    tags: JSON.stringify(event.tags),
    contexts: JSON.stringify(event.contexts),
    exception: JSON.stringify(event.exception),
    stacktrace: JSON.stringify(event.stacktrace ?? {}),
    raw_payload: event.rawPayload,
  };
}

// The three frames are the tail of a stored student-web-app event: two in the entry chunk (minified, line 3)
// and one in a lazy chunk. Only the entry chunk gets a source map below.
const webFrames = [
  { filename: "https://myyogateacher.com/web-zoom/assets/index-DoLlnhss.js", function: "Object.jt [as withScope]", lineno: 3, colno: 17780 },
  { filename: "https://myyogateacher.com/web-zoom/assets/index-DoLlnhss.js", function: "kt.withScope", lineno: 3, colno: 17186 },
  { filename: "https://myyogateacher.com/web-zoom/assets/Zoom-D9aLBtGk.js", function: "?", lineno: 589, colno: 22937 },
];
const webException = (frames: unknown[]) => ({ values: [{ type: "ZoomMeetingJoinStalled", value: "stalled", stacktrace: { frames } }] });

const releaseWithMap = `rel_map_${suffix}`;
const releaseWithoutMap = `rel_nomap_${suffix}`;
const ids = { homeA: `e_home_a_${suffix}`, zoomB: `e_zoom_b_${suffix}`, otherKeyC: `e_otherkey_c_${suffix}`, longerValueD: `e_longer_d_${suffix}`, dotKeyE: `e_dot_e_${suffix}`, otherProjectF: `e_other_f_${suffix}`, mapped: `e_mapped_${suffix}`, unmapped: `e_unmapped_${suffix}` };

const rows = [
  eventRow(projectWeb, { event_id: ids.homeA, fingerprint: ["g1"], message: "boom home", tags: { app: "web_home" } }),
  eventRow(projectWeb, { event_id: ids.zoomB, fingerprint: ["g1"], message: "boom home", tags: { app: "web_zoom" } }),
  eventRow(projectWeb, { event_id: ids.otherKeyC, fingerprint: ["g2"], message: "boom other", tags: { other: "web_home" } }),
  eventRow(projectWeb, { event_id: ids.longerValueD, fingerprint: ["g2"], message: "boom other", tags: { app: "web_home_extra" } }),
  eventRow(projectWeb, { event_id: ids.dotKeyE, fingerprint: ["g2"], message: "boom other", tags: { "join.stage": "connecting" } }),
  eventRow(projectOther, { event_id: ids.otherProjectF, fingerprint: ["g1"], message: "boom home", tags: { app: "web_home" } }),
  eventRow(projectWeb, { event_id: ids.mapped, fingerprint: ["g3"], release: releaseWithMap, exception: webException(webFrames) }),
  eventRow(projectWeb, { event_id: ids.unmapped, fingerprint: ["g4"], release: releaseWithoutMap, exception: webException(webFrames) }),
];

beforeAll(() => {
  const events = rows
    .map((row) => `SELECT ${Object.entries(row).map(([column, value]) => `${literal(value)} AS ${column}`).join(", ")}, ${chTime(eventAt)} AS timestamp`)
    .join(" UNION ALL ");
  const breadcrumbs = `SELECT ${literal(ids.mapped)} AS event_id, ${literal(projectWeb)} AS project_id, 'g3' AS group_id, ${chTime(eventAt)} AS timestamp, 'ui.click' AS category, 'info' AS level, 'clicked join' AS message, 'default' AS type, '{}' AS data`;
  shadowTables = `events AS (${events}), breadcrumbs AS (${breadcrumbs})`;
});

// SQLite side of deobfuscateEvent: the project row and one uploaded source map for releaseWithMap.
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [projectWeb, `Web ${suffix}`, `web-${suffix}`, "production", 1, now, now]);
const generator = new SourceMapGenerator({ file: "index-DoLlnhss.js" });
// colno 17780 is 1-based, deobfuscateEvent looks up column 17779.
generator.addMapping({ generated: { line: 3, column: 17779 }, source: "src/zoom/join.ts", original: { line: 12, column: 4 }, name: "joinMeeting" });
const artifact = saveMinimapArtifact({
  org: config.EKEEPER_ORG,
  projectId: projectWeb,
  project: `web-${suffix}`,
  release: releaseWithMap,
  artifactName: "~/web-zoom/assets/index-DoLlnhss.js.map",
  buffer: Buffer.from(generator.toString()),
});

afterAll(() => {
  shadowTables = "";
  if (existsSync(artifact.filePath)) rmSync(artifact.filePath, { force: true });
  run(`DELETE FROM minimap_artifacts WHERE project_id = ?`, [projectWeb]);
  run(`DELETE FROM projects WHERE id = ?`, [projectWeb]);
});

const callTool = async <T>(name: string, args: Record<string, unknown>, projectIds = [projectWeb]) =>
  (await getTool(name)!.handler(projectIds, args)) as T;

describe("top_issues", () => {
  test("runs on the engine: no outer alias shadows a column the WHERE names", async () => {
    const result = await callTool<Array<Record<string, unknown>>>("top_issues", {});

    const byGroup = Object.fromEntries(result.map((row) => [row.group_id, row]));
    expect(Number(byGroup["g1"]?.events)).toBe(2);
    expect(Number(byGroup["g2"]?.events)).toBe(3);
    expect(byGroup["g1"]?.project_id).toBe(projectWeb);
    expect(byGroup["g1"]?.title).toContain("boom home");
  });

  test("still runs with message_contains and title_contains, which collided with the title and message aliases", async () => {
    const result = await callTool<Array<Record<string, unknown>>>("top_issues", { message_contains: "boom other", title_contains: "boom other" });

    expect(result.map((row) => row.group_id)).toEqual(["g2"]);
  });

  test("never counts events of a project outside the caller's project ids", async () => {
    const result = await callTool<Array<Record<string, unknown>>>("top_issues", {});

    expect(Number(result.find((row) => row.group_id === "g1")?.events)).toBe(2);
    expect(await callTool("top_issues", {}, [projectOther])).toHaveLength(1);
  });
});

describe("top_issues across projects", () => {
  test("a group_id shared by two projects is one row per project, each with its own count and project_id", async () => {
    const result = await callTool<Array<Record<string, unknown>>>("top_issues", { message_contains: "boom home" }, [projectWeb, projectOther]);

    const rows = result.map((row) => [row.group_id, row.project_id, Number(row.events)]).sort();
    expect(rows).toEqual([["g1", projectOther, 1], ["g1", projectWeb, 2]].sort());
  });
});

describe("tag filter", () => {
  const searchIds = async (tag: string) => (await callTool<Array<{ event_id: string }>>("search_events", { tag })).map((row) => row.event_id).sort();

  test("matches only the exact key and value, not another key with that value, nor a longer value", async () => {
    expect(await searchIds("app:web_home")).toEqual([ids.homeA]);
  });

  test("treats a dotted key as one literal key, not a path", async () => {
    expect(await searchIds("join.stage:connecting")).toEqual([ids.dotKeyE]);
  });

  test("a tag value cannot change the query: it travels as a parameter and quoting characters match nothing", async () => {
    const hostile = `x' OR '1'='1`;
    const { clause, params } = buildWhere([projectWeb], { tag: `app:${hostile}` });

    expect(clause).not.toContain(hostile);
    expect(params.tag_value).toBe(hostile);
    expect(await searchIds(`app:${hostile}`)).toEqual([]);
  });

  test("applies to error_trend and top_issues through the same clause", async () => {
    const trend = await callTool<Array<{ events: string | number }>>("error_trend", { tag: "app:web_zoom" });
    const issues = await callTool<Array<{ group_id: string; events: string | number }>>("top_issues", { tag: "app:web_zoom" });

    expect(trend.map((row) => Number(row.events))).toEqual([1]);
    expect(issues.map((row) => [row.group_id, Number(row.events)])).toEqual([["g1", 1]]);
  });

  test("search_events returns each event's tags", async () => {
    const [event] = await callTool<Array<{ tags: string }>>("search_events", { tag: "app:web_zoom" });

    expect(JSON.parse(event!.tags)).toEqual({ app: "web_zoom" });
  });
});

describe("get_event stack frames", () => {
  const frames = async (eventId: string) => {
    const { event } = await callTool<{ event: { stacktrace: { frames: Array<Record<string, unknown>> }; exception: { values: Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }> } } }>("get_event", { event_id: eventId });
    return { stacktraceFrames: event.stacktrace.frames, exceptionFrames: event.exception.values[0]!.stacktrace.frames };
  };

  test("returns original source positions for frames an uploaded source map covers, and leaves the others as stored", async () => {
    const { stacktraceFrames, exceptionFrames } = await frames(ids.mapped);

    for (const result of [stacktraceFrames, exceptionFrames]) {
      expect(result[0]).toMatchObject({ filename: "src/zoom/join.ts", function: "joinMeeting", lineno: 12, colno: 5, deobfuscated: true, compiledFilename: webFrames[0]!.filename });
      expect(result[2]).toEqual(webFrames[2]!);
    }
  });

  test("returns the stored frames unchanged when no source map exists for the release", async () => {
    const { stacktraceFrames, exceptionFrames } = await frames(ids.unmapped);

    expect(stacktraceFrames).toEqual(webFrames);
    expect(exceptionFrames).toEqual(webFrames);
  });

  test("still returns breadcrumbs and the unsymbolicated columns beside the stack", async () => {
    const result = await callTool<{ event: Record<string, unknown>; breadcrumbs: Array<{ message: string }> }>("get_event", { event_id: ids.mapped });

    expect(result.breadcrumbs.map((crumb) => crumb.message)).toEqual(["clicked join"]);
    expect(result.event.event_id).toBe(ids.mapped);
    expect(result.event.release).toBe(releaseWithMap);
  });
});
