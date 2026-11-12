import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breadcrumbPreview,
  eventLevel,
  eventNav,
  framesCrashFirst,
  occurrenceStats,
  splitTitle,
  statusActions,
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
