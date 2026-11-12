// Every time the UI shows goes through this module, so the one wire quirk below is handled in one place.
//
// ClickHouse columns are DateTime64(3, 'UTC') and the API reads them as JSONEachRow with no output format,
// so firstSeen, lastSeen, event and breadcrumb times arrive as "2026-11-12 10:59:55.890": UTC digits with
// no zone. `new Date()` reads that shape as the viewer's local time, which put every time 5h30m early for
// viewers in India. SQLite dates arrive as ISO with "Z" and must not be shifted. Precedent: this repo had
// no shared parser; formatDate in lib/utils.ts called new Date(value) directly.
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** Parses a server timestamp. A value without a zone is UTC. Returns null for missing or invalid input. */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const zoneless = ZONELESS.exec(value.trim());
  const parsed = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Milliseconds since the server time, or null when the value cannot be read. */
export function ageMs(value: string | null | undefined, now: number): number | null {
  const parsed = parseServerTime(value);
  return parsed ? now - parsed.getTime() : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "5m ago", "3h ago", "12d ago". A time ahead of the viewer's clock (server and laptop clocks
 * disagree by seconds routinely) reads as "just now" rather than a negative age.
 */
export function formatRelative(value: string | null | undefined, now: number): string {
  const age = ageMs(value, now);
  if (age === null) {
    return "never";
  }
  if (age < MINUTE) {
    return "just now";
  }
  if (age < HOUR) {
    return `${Math.floor(age / MINUTE)}m ago`;
  }
  if (age < DAY) {
    return `${Math.floor(age / HOUR)}h ago`;
  }
  return `${Math.floor(age / DAY)}d ago`;
}

/**
 * "12 Nov 2026, 16:29 GMT+5:30". The zone is always printed so a screenshot pasted into Slack cannot be
 * misread by someone in another zone.
 */
export function formatAbsolute(value: string | null | undefined, timeZone?: string): string {
  const parsed = parseServerTime(value);
  if (!parsed) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
    timeZone,
  }).format(parsed);
}

/**
 * The instants that bound whole local days from `fromDay` to `toDay` (both "YYYY-MM-DD", inclusive).
 * Sent as ISO instants because the server snaps a bare date to UTC days (backend/src/routes/api.ts:292),
 * which would shift an India viewer's day by 5h30m. Known limit, server side: it truncates bounds to
 * whole seconds and compares max(timestamp) <= to, so an issue last seen in the final second of the day
 * can be left out.
 */
export function localDayRange(fromDay: string, toDay: string): { from: string; to: string } | null {
  const start = parseLocalDay(fromDay);
  const end = parseLocalDay(toDay);
  if (!start || !end || start > end) {
    return null;
  }
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: endOfDay.toISOString() };
}

function parseLocalDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}
