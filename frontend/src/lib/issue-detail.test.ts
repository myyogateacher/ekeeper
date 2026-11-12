import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breadcrumbOffset,
  breadcrumbPreview,
  eventLevel,
  eventNav,
  exceptionParts,
  framesCrashFirst,
  occurrenceStats,
  parseMaybeJson,
  splitTitle,
  statusActions,
  undoState,
} from "./issue-detail.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const HOUR = 3_600_000;
// ClickHouse shape: UTC digits, no zone.
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString().replace("T", " ").replace("Z", "");

// The chart and the 24h stat sit side by side; if they disagree the page contradicts itself.
test("hourly buckets cover the last 24 hours and sum to the 24h count, and an occurrence exactly 24h old is outside", () => {
  const occurrences = [0, 30 * 60_000, 5 * HOUR, 23 * HOUR + 59 * 60_000, 24 * HOUR, 3 * 24 * HOUR, 8 * 24 * HOUR].map(
    (ago, index) => ({ eventId: `e${index}`, timestamp: at(ago) }),
  );
  const stats = occurrenceStats(occurrences, NOW);
  assert.equal(stats.hourly.length, 24);
  assert.equal(stats.count24h, 4);
  assert.equal(stats.hourly.reduce((a, b) => a + b, 0), stats.count24h);
  assert.equal(stats.hourly[23], 2);
  assert.equal(stats.hourly[18], 1);
  assert.equal(stats.hourly[0], 1);
  assert.equal(stats.count7d, 6);
  assert.equal(stats.lastSeen, occurrences[0].timestamp);
  assert.equal(stats.firstSeen, occurrences[6].timestamp);
});

test("an event stamped ahead of the viewer's clock lands in the latest hour, not off the chart", () => {
  const stats = occurrenceStats([{ eventId: "f", timestamp: at(-5 * 60_000) }], NOW);
  assert.equal(stats.hourly[23], 1);
});

test("Newer and Latest are absent on the latest event, Older and Oldest on the oldest", () => {
  const occurrences = ["a", "b", "c"].map((eventId) => ({ eventId, timestamp: at(0) }));
  assert.deepEqual(eventNav(occurrences, "a"), { index: 0, total: 3, latest: null, newer: null, older: "b", oldest: "c" });
  assert.deepEqual(eventNav(occurrences, "b"), { index: 1, total: 3, latest: "a", newer: "a", older: "c", oldest: "c" });
  assert.deepEqual(eventNav(occurrences, "c"), { index: 2, total: 3, latest: "a", newer: "b", older: null, oldest: null });
  assert.deepEqual(eventNav(occurrences.slice(0, 1), "a"), { index: 0, total: 1, latest: null, newer: null, older: null, oldest: null });
  assert.equal(eventNav(occurrences, "gone").older, null);
});

// Undo re-sends the state held before, so each primary must be the inverse of a reachable state.
test("each state offers exactly one primary action, and Mark as open only on reopened", () => {
  assert.deepEqual(statusActions("open"), { primary: { label: "Close issue", state: "closed" }, secondary: null });
  assert.deepEqual(statusActions("reopened"), {
    primary: { label: "Close issue", state: "closed" },
    secondary: { label: "Mark as open", state: "open" },
  });
  assert.deepEqual(statusActions("closed"), { primary: { label: "Reopen", state: "reopened" }, secondary: null });
});

test("frames read crash site first, falling back to the exception's stack when the event's is missing or empty", () => {
  const frames = [{ function: "outer" }, { function: "inner" }];
  assert.deepEqual(framesCrashFirst({ frames }, null).map((frame) => frame.function), ["inner", "outer"]);
  assert.deepEqual(framesCrashFirst(JSON.stringify({ frames }), null).map((frame) => frame.function), ["inner", "outer"]);
  const exception = { values: [{ stacktrace: { frames } }] };
  assert.deepEqual(framesCrashFirst({ frames: [] }, exception).map((frame) => frame.function), ["inner", "outer"]);
  assert.deepEqual(framesCrashFirst(null, {}), []);
  assert.deepEqual(frames.map((frame) => frame.function), ["outer", "inner"], "input is not mutated");
});

test("a title with no type separator renders whole", () => {
  assert.deepEqual(splitTitle("TypeError: x is undefined"), ["TypeError", "x is undefined"]);
  assert.deepEqual(splitTitle("Script error."), ["Script error.", ""]);
  assert.deepEqual(splitTitle(": leading"), [": leading", ""]);
});

// Fixture in the server's order, newest first (routes/api.ts:881). c9 happened just before the error.
test("breadcrumb preview is the seven just before the error, oldest first", () => {
  const crumbs = Array.from({ length: 10 }, (_, index) => ({
    timestamp: at((index + 1) * 1000),
    category: `c${9 - index}`,
    level: "info",
    message: "",
    type: "default",
    data: {},
  }));
  assert.deepEqual(breadcrumbPreview(crumbs, false).map((crumb) => crumb.category), ["c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
  assert.deepEqual(breadcrumbPreview(crumbs, true).map((crumb) => crumb.category), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
  assert.equal(crumbs[0].category, "c9", "input is not mutated");
});

test("an event with no level, or an unreadable payload, reads as error", () => {
  assert.equal(eventLevel(JSON.stringify({ level: "Warning" })), "warning");
  assert.equal(eventLevel(JSON.stringify({})), "error");
  assert.equal(eventLevel("not json"), "error");
});

// The canvas shows each breadcrumb as its distance before the error ("-8.4s"), so a reader sees what led to it
// and how fast. Crumb and event times are both ClickHouse zone-less strings; only the difference matters.
test("a breadcrumb reads as its distance before the error, in seconds, then minutes, then hours", () => {
  const at = "2026-11-12 11:37:48.451";
  assert.equal(breadcrumbOffset("2026-11-12 11:37:40.051", at), "-8.4s");
  assert.equal(breadcrumbOffset("2026-11-12 11:37:48.251", at), "-0.2s");
  assert.equal(breadcrumbOffset("2026-11-12 11:37:48.451", at), "0.0s");
  // 59.96 s rounds to 60.0 s; it must read as a minute, not "-60.0s".
  assert.equal(breadcrumbOffset("2026-11-12 11:36:48.491", at), "-1m 00s");
  assert.equal(breadcrumbOffset("2026-11-12 11:35:43.451", at), "-2m 05s");
  assert.equal(breadcrumbOffset("2026-11-12 10:32:48.451", at), "-1h 05m");
});

test("a breadcrumb stamped after the error reads with a plus, and an unreadable time reads as nothing", () => {
  const at = "2026-11-12 11:37:48.451";
  assert.equal(breadcrumbOffset("2026-11-12 11:37:48.751", at), "+0.3s");
  assert.equal(breadcrumbOffset("", at), null);
  assert.equal(breadcrumbOffset("2026-11-12 11:37:48.451", "not a date"), null);
});

// Undo must send the state held before the change, not a guess from the new one: closing a reopened issue and
// undoing has to land on reopened, not on open, or Undo silently rewrites the issue's history. The state
// before is read from the row at click time, so this is the one place the rule lives.
test("Undo restores the state held before the change, whether that was open or reopened", () => {
  assert.equal(undoState("open", statusActions("open").primary.state), "open");
  assert.equal(undoState("reopened", statusActions("reopened").primary.state), "reopened");
  assert.equal(undoState("reopened", statusActions("reopened").secondary!.state), "reopened");
  assert.equal(undoState("closed", statusActions("closed").primary.state), "closed");
});

test("no Undo is offered when the state before is unknown or did not change", () => {
  assert.equal(undoState(undefined, "closed"), null);
  assert.equal(undoState("open", "open"), null);
});

// SDK payloads nest JSON as text, and the text is whatever the sender wrote. An event with "user":"null" parsed
// to null, the rail read null.id, and with no error boundary the whole app went blank on that issue's page
// (security review of PROD-10519). A parse result is only usable if it has the shape the caller reads, so
// anything else is the caller's fallback, by identity.
test("JSON text or a value that is not the object shape the caller reads gives the fallback", () => {
  const fallback = {};
  for (const input of ["null", "[]", "1", '"text"', "true", "not json", null, undefined, 5, [null], []]) {
    assert.equal(parseMaybeJson<Record<string, unknown>>(input, fallback), fallback, String(input));
  }
  assert.deepEqual(parseMaybeJson('{"id":7}', {}), { id: 7 });
  assert.deepEqual(parseMaybeJson({ id: 7 }, {}), { id: 7 });
});

test("a caller that expects an array gets arrays, and never an object", () => {
  const fallback: unknown[] = [];
  assert.deepEqual(parseMaybeJson("[1,2]", fallback), [1, 2]);
  assert.equal(parseMaybeJson('{"a":1}', fallback), fallback);
  assert.equal(parseMaybeJson("null", fallback), fallback);
});

test("a stack of null, scalar or array frames shows only the real frames, and never throws", () => {
  const frames = '{"frames":[null,1,"x",[],{"function":"outer"},{"function":"crash"}]}';
  assert.deepEqual(framesCrashFirst(frames, null), [{ function: "crash" }, { function: "outer" }]);
  assert.deepEqual(framesCrashFirst("null", "null"), []);
  assert.deepEqual(framesCrashFirst(null, { values: [null] }), []);
  assert.deepEqual(framesCrashFirst(null, { values: [{ stacktrace: { frames: [null, { function: "f" }] } }] }), [{ function: "f" }]);
});

test("an exception or level that is JSON null reads as the defaults, never throws", () => {
  assert.deepEqual(exceptionParts("null"), { type: "Error", value: "No exception message", mechanism: null });
  assert.deepEqual(exceptionParts('{"values":[null]}'), { type: "Error", value: "No exception message", mechanism: null });
  assert.equal(eventLevel("null"), "error");
  assert.equal(eventLevel("[]"), "error");
});
