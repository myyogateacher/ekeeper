import type { EventNavigation, IssueStats } from "@ekeeper/shared";

// Pure shaping for the issue page's whole-group figures. The ClickHouse queries live in routes/api.ts
// (queryGroupStats, queryEventNavigation); what comes back from them is raw JSONEachRow, where every UInt64 is a
// string and a time is whatever the SQL selected. This file turns those rows into the contract in
// shared/src/contracts.ts and holds every branch worth a table test, so nothing here touches I/O.

// The chart has 24 bars, as the canvas draws and as the client side chart this replaced counted: that chart was built
// in the browser from the list of every occurrence the detail response used to carry, and also used 24 buckets.
export const HOURLY_BUCKETS = 24;

// The totals and the 24 hourly counts come back as ONE row from ONE query, because ClickHouse reads `now()` once
// per query: every window in that row shares one clock, so sum(hourly24h) equals events24h exactly. Two queries
// would each read their own now() and could disagree by an event that crossed a bucket edge between them.
// Bucket i holds [now - (24 - i)h, now - (23 - i)h), and the last has no upper bound, so an event stamped ahead of
// the server clock is counted there, the way events24h counts it, instead of being in a window and no bar.
//
// `now('UTC')` and hour intervals, not `now() - INTERVAL 1 DAY` like the list's countIf: a day interval follows the
// server time zone's calendar and is 23 or 25 hours across a daylight saving change, which would make the
// window and the buckets disagree twice a year. UTC has no such day.
export const EVENTS_24H_SQL = "countIf(timestamp >= now('UTC') - INTERVAL 24 HOUR)";
export const EVENTS_7D_SQL = "countIf(timestamp >= now('UTC') - INTERVAL 168 HOUR)";

/**
 * The 24 `countIf(...) AS hourN` select items, oldest first. Static text built from constants, never from input.
 * The aliases hour0 to hour23 are not columns of `events` (defect register 20); hourlyFromRow reads them back.
 */
export function hourlyColumnsSql(): string {
  return Array.from({ length: HOURLY_BUCKETS }, (_, index) => {
    const from = `timestamp >= now('UTC') - INTERVAL ${HOURLY_BUCKETS - index} HOUR`;
    const to = index === HOURLY_BUCKETS - 1 ? "" : ` AND timestamp < now('UTC') - INTERVAL ${HOURLY_BUCKETS - 1 - index} HOUR`;
    return `countIf(${from}${to}) AS hour${index}`;
  }).join(",\n        ");
}

export type StatsRow = {
  totalEvents: string | number;
  events24h: string | number;
  events7d: string | number;
  // Milliseconds since the epoch (toUnixTimestamp64Milli). ClickHouse returns the type's default, 0, for min and
  // max over no rows, so a group with no events is read from totalEvents, never from these.
  firstSeenMs: string | number;
  lastSeenMs: string | number;
} & Record<string, string | number>;

/**
 * Milliseconds since the epoch to ISO 8601 UTC with Z. The ClickHouse JSON output prints DateTime64 as digits
 * with no zone, which every reader has to know is UTC (frontend/src/lib/time.ts); a time built here carries its
 * zone on the wire (defect register entry 14).
 */
export function isoFromEpochMs(value: string | number): string {
  return new Date(Number(value)).toISOString();
}

/** The hour0 to hour23 columns of a stats row as 24 numbers, oldest first. */
export function hourlyFromRow(row: Record<string, string | number>): number[] {
  return Array.from({ length: HOURLY_BUCKETS }, (_, index) => Number(row[`hour${index}`]));
}

export function buildIssueStats(row: StatsRow): IssueStats {
  const totalEvents = Number(row.totalEvents);
  return {
    totalEvents,
    events24h: Number(row.events24h),
    events7d: Number(row.events7d),
    hourly24h: hourlyFromRow(row),
    firstSeen: totalEvents > 0 ? isoFromEpochMs(row.firstSeenMs) : null,
    lastSeen: totalEvents > 0 ? isoFromEpochMs(row.lastSeenMs) : null,
  };
}

export interface NavigationRow {
  totalEvents: string | number;
  // Events strictly newer and strictly older than the shown one, in (timestamp, event_id) order.
  newerCount: string | number;
  olderCount: string | number;
  latestEventId: string;
  oldestEventId: string;
  // argMinIf and argMaxIf return the type's default, an empty string, when no row matches, and an event id can
  // itself be '' (ingest takes any payload.event_id that is not null), so the counts above decide whether
  // these are real, never the strings.
  newerEventId: string;
  olderEventId: string;
}

export function buildEventNavigation(row: NavigationRow): EventNavigation {
  const newerCount = Number(row.newerCount);
  return {
    latestEventId: row.latestEventId,
    oldestEventId: row.oldestEventId,
    newerEventId: newerCount > 0 ? row.newerEventId : null,
    olderEventId: Number(row.olderCount) > 0 ? row.olderEventId : null,
    position: newerCount + 1,
    total: Number(row.totalEvents),
  };
}
