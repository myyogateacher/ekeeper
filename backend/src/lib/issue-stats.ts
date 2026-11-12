import type { EventNavigation, IssueStats } from "@ekeeper/shared";

// Pure shaping for the issue page's whole-group figures. The ClickHouse queries live in routes/api.ts
// (queryGroupStats, queryEventNavigation); what comes back from them is raw JSONEachRow, where every UInt64 is a
// string and a time is whatever the SQL selected. This file turns those rows into the contract in
// shared/src/contracts.ts and holds every branch worth a table test, so nothing here touches I/O.

// The chart is one bar per UTC clock hour for the last 24 hours. Same count as the old client side chart
// (frontend/src/lib/issue-detail.ts occurrenceStats, `new Array(24)`), and the canvas draws 24 bars.
export const HOURLY_BUCKETS = 24;

export interface StatsTotalsRow {
  totalEvents: string | number;
  events24h: string | number;
  events7d: string | number;
  // Milliseconds since the epoch (toUnixTimestamp64Milli). ClickHouse returns the type's default, 0, for min and
  // max over no rows, so a group with no events is read from totalEvents, never from these.
  firstSeenMs: string | number;
  lastSeenMs: string | number;
}

export interface HourlyRow {
  // 0 is the hour containing now, 23 is 23 hours earlier.
  hoursAgo: string | number;
  eventCount: string | number;
}

/**
 * Milliseconds since the epoch to ISO 8601 UTC with Z. The ClickHouse JSON output prints DateTime64 as digits
 * with no zone, which every reader has to know is UTC (frontend/src/lib/time.ts); a time built here carries its
 * zone on the wire (defect register entry 14).
 */
export function isoFromEpochMs(value: string | number): string {
  return new Date(Number(value)).toISOString();
}

/**
 * 24 counts, oldest first, from the sparse rows ClickHouse returns (an hour with no event has no row). Entry 23
 * is the hour containing now. A row outside 0 to 23 or with a non-integer hoursAgo is ignored rather than
 * thrown on: the query bounds the window, so this only guards the array from being indexed out of range.
 */
export function fillHourly(rows: HourlyRow[]): number[] {
  const hourly = new Array<number>(HOURLY_BUCKETS).fill(0);
  for (const row of rows) {
    const hoursAgo = Number(row.hoursAgo);
    if (Number.isInteger(hoursAgo) && hoursAgo >= 0 && hoursAgo < HOURLY_BUCKETS) {
      hourly[HOURLY_BUCKETS - 1 - hoursAgo] = Number(row.eventCount);
    }
  }
  return hourly;
}

export function buildIssueStats(totals: StatsTotalsRow, hourlyRows: HourlyRow[]): IssueStats {
  const totalEvents = Number(totals.totalEvents);
  return {
    totalEvents,
    events24h: Number(totals.events24h),
    events7d: Number(totals.events7d),
    hourly24h: fillHourly(hourlyRows),
    firstSeen: totalEvents > 0 ? isoFromEpochMs(totals.firstSeenMs) : null,
    lastSeen: totalEvents > 0 ? isoFromEpochMs(totals.lastSeenMs) : null,
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
