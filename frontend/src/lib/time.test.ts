import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAbsolute, formatRelative, localDayRange, parseServerTime } from "./time.ts";

// The bug this module exists for: ClickHouse sends UTC digits with no zone, and the old formatDate read
// them as local time. In Asia/Kolkata that showed 10:59 for an event at 16:29 local.
test("a ClickHouse timestamp without a zone is read as UTC, never as the viewer's local time", () => {
  assert.equal(parseServerTime("2026-11-12 10:59:55.890")?.toISOString(), "2026-11-12T10:59:55.890Z");
  assert.equal(parseServerTime("2026-11-12 10:59:55")?.toISOString(), "2026-11-12T10:59:55.000Z");
  assert.equal(
    formatAbsolute("2026-11-12 10:59:55.890", "Asia/Kolkata"),
    "12 Nov 2026, 16:29 GMT+5:30",
  );
});

test("an ISO timestamp that carries its zone is not shifted", () => {
  assert.equal(parseServerTime("2026-11-12T10:59:55.890Z")?.toISOString(), "2026-11-12T10:59:55.890Z");
  assert.equal(parseServerTime("2026-11-12T16:29:55.890+05:30")?.toISOString(), "2026-11-12T10:59:55.890Z");
});

test("missing or unreadable times are null, and print as Unknown or never", () => {
  assert.equal(parseServerTime(null), null);
  assert.equal(parseServerTime("not a date"), null);
  assert.equal(formatAbsolute(""), "Unknown");
  assert.equal(formatRelative(undefined, Date.now()), "never");
});

// Server and browser clocks drift by seconds; an event "from the future" must not render "-1m ago".
test("an event stamped ahead of the viewer's clock reads as just now, never as a negative age", () => {
  const now = Date.parse("2026-11-12T10:59:00.000Z");
  assert.equal(formatRelative("2026-11-12 10:59:30.000", now), "just now");
});

test("relative ages step from minutes to hours to days at the boundaries", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  assert.equal(formatRelative("2026-11-12 11:59:01", now), "just now");
  assert.equal(formatRelative("2026-11-12 11:59:00", now), "1m ago");
  assert.equal(formatRelative("2026-11-12 11:00:00", now), "1h ago");
  assert.equal(formatRelative("2026-11-11 12:00:00", now), "1d ago");
});

// Runs under whatever TZ the process has; the assertions are written against local wall-clock parts so
// they hold in UTC and in Asia/Kolkata alike.
test("a custom range covers the viewer's local days from the start of the first to the end of the last", () => {
  const range = localDayRange("2026-11-10", "2026-11-12");
  assert.ok(range);
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert.deepEqual([from.getDate(), from.getHours(), from.getMinutes()], [10, 0, 0]);
  assert.deepEqual([to.getDate(), to.getHours(), to.getMinutes(), to.getSeconds()], [12, 23, 59, 59]);
});

test("a custom range that ends before it starts, or is malformed, is rejected rather than sent", () => {
  assert.equal(localDayRange("2026-11-12", "2026-11-10"), null);
  assert.equal(localDayRange("12/11/2026", "2026-11-12"), null);
});
