import { describe, expect, test } from "bun:test";
import { EVENTS_24H_SQL, buildEventNavigation, buildIssueStats, hourlyColumnsSql, hourlyFromRow, isoFromEpochMs } from "./issue-stats";

describe("isoFromEpochMs", () => {
  test("carries the zone: ISO 8601 UTC with Z, from a number or the string ClickHouse returns for a UInt64", () => {
    expect(isoFromEpochMs(1_731_494_400_123)).toBe("2024-11-13T10:40:00.123Z");
    expect(isoFromEpochMs("1731494400123")).toBe("2024-11-13T10:40:00.123Z");
  });
});

const hours = (values: Record<number, number>) => Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`hour${index}`, values[index] ?? 0]));

describe("hourlyColumnsSql", () => {
  const lines = hourlyColumnsSql().split(",\n").map((line) => line.trim());

  test("24 countIf columns named hour0 to hour23, oldest first", () => {
    expect(lines).toHaveLength(24);
    lines.forEach((line, index) => expect(line.endsWith(` AS hour${index}`)).toBe(true));
  });

  test("bucket i is [now - (24 - i)h, now - (23 - i)h): each bucket starts where the one before it ends", () => {
    expect(lines[0]).toBe("countIf(timestamp >= now('UTC') - INTERVAL 24 HOUR AND timestamp < now('UTC') - INTERVAL 23 HOUR) AS hour0");
    expect(lines[11]).toBe("countIf(timestamp >= now('UTC') - INTERVAL 13 HOUR AND timestamp < now('UTC') - INTERVAL 12 HOUR) AS hour11");
    expect(lines[22]).toBe("countIf(timestamp >= now('UTC') - INTERVAL 2 HOUR AND timestamp < now('UTC') - INTERVAL 1 HOUR) AS hour22");
  });

  test("the last bucket has no upper bound, and the first starts where events24h starts", () => {
    expect(lines[23]).toBe("countIf(timestamp >= now('UTC') - INTERVAL 1 HOUR) AS hour23");
    expect(EVENTS_24H_SQL).toBe("countIf(timestamp >= now('UTC') - INTERVAL 24 HOUR)");
    expect(lines[0]).toContain("now('UTC') - INTERVAL 24 HOUR");
  });

  test("it is a fixed string built from constants: it holds no placeholder and no user input", () => {
    expect(hourlyColumnsSql()).not.toMatch(/[{}]/);
  });
});

describe("hourlyFromRow", () => {
  test("24 numbers oldest first from the hour0 to hour23 columns, strings included", () => {
    const result = hourlyFromRow({ ...hours({ 0: 2, 18: 3 }), hour23: "7" });

    expect(result).toHaveLength(24);
    expect(result[0]).toBe(2);
    expect(result[18]).toBe(3);
    expect(result[23]).toBe(7);
    expect(result.reduce((sum, count) => sum + count, 0)).toBe(12);
  });
});

describe("buildIssueStats", () => {
  const totals = { totalEvents: "1904", events24h: "412", events7d: "1904", firstSeenMs: "1731494400000", lastSeenMs: "1731498000000" };

  test("numbers from strings, times as ISO with Z, the chart from the hour columns", () => {
    expect(buildIssueStats({ ...totals, ...hours({ 23: 33 }) })).toEqual({
      totalEvents: 1904,
      events24h: 412,
      events7d: 1904,
      hourly24h: [...new Array<number>(23).fill(0), 33],
      firstSeen: "2024-11-13T10:40:00.000Z",
      lastSeen: "2024-11-13T11:40:00.000Z",
    });
  });

  test("a group with no events has null times, not 1970 from the empty min and max", () => {
    const empty = buildIssueStats({ totalEvents: "0", events24h: "0", events7d: "0", firstSeenMs: "0", lastSeenMs: "0", ...hours({}) });

    expect(empty.firstSeen).toBeNull();
    expect(empty.lastSeen).toBeNull();
    expect(empty.totalEvents).toBe(0);
  });
});

describe("buildEventNavigation", () => {
  const base = { totalEvents: "5", latestEventId: "e5", oldestEventId: "e1", newerEventId: "e4", olderEventId: "e2" };

  test("the middle of a group: both neighbours, position 1 based from the newest", () => {
    expect(buildEventNavigation({ ...base, newerCount: "2", olderCount: "2" })).toEqual({
      latestEventId: "e5",
      oldestEventId: "e1",
      newerEventId: "e4",
      olderEventId: "e2",
      position: 3,
      total: 5,
    });
  });

  test("the newest event has no newer neighbour and is position 1", () => {
    const nav = buildEventNavigation({ ...base, newerCount: "0", olderCount: "4", newerEventId: "", olderEventId: "e4" });

    expect(nav).toMatchObject({ newerEventId: null, olderEventId: "e4", position: 1, total: 5, latestEventId: "e5" });
  });

  test("the oldest event has no older neighbour and its position equals the total", () => {
    const nav = buildEventNavigation({ ...base, newerCount: "4", olderCount: "0", olderEventId: "", newerEventId: "e2" });

    expect(nav).toMatchObject({ olderEventId: null, newerEventId: "e2", position: 5, total: 5, oldestEventId: "e1" });
  });

  test("a single event has neither neighbour", () => {
    const nav = buildEventNavigation({ totalEvents: "1", newerCount: "0", olderCount: "0", latestEventId: "only", oldestEventId: "only", newerEventId: "", olderEventId: "" });

    expect(nav).toEqual({ latestEventId: "only", oldestEventId: "only", newerEventId: null, olderEventId: null, position: 1, total: 1 });
  });

  test("an event whose id is the empty string is a real neighbour when the count says so", () => {
    const nav = buildEventNavigation({ ...base, newerCount: "1", olderCount: "1", newerEventId: "", olderEventId: "" });

    expect(nav.newerEventId).toBe("");
    expect(nav.olderEventId).toBe("");
  });
});
