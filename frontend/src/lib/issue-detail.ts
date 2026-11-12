// Pure helpers for the issue detail page, kept out of the component so each rule has a test.
import type { Breadcrumb, IssueState, OccurrenceSummary } from "@ekeeper/shared";
import { parseServerTime } from "./time.ts";

type UnknownRecord = Record<string, unknown>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Titles are always "<type>: <message>" (backend/src/lib/ingest.ts:191); a title without one renders whole. */
export function splitTitle(title: string): [string, string] {
  const index = title.indexOf(": ");
  return index > 0 ? [title.slice(0, index), title.slice(index + 2)] : [title, ""];
}

export interface OccurrenceStats {
  count24h: number;
  count7d: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** 24 rolling hours, oldest first: index 23 is the hour ending now. */
  hourly: number[];
}

/**
 * Stats and the 24 hour chart from one pass with one `now`, so the chart always sums to the 24h number
 * beside it. The detail endpoint sends every occurrence of the group newest first with no LIMIT
 * (backend/src/routes/api.ts:836-846), which is what makes these exact rather than sampled. An event
 * stamped ahead of the viewer's clock counts in the latest hour rather than falling off the chart.
 */
export function occurrenceStats(occurrences: OccurrenceSummary[], now: number): OccurrenceStats {
  const hourly = new Array<number>(24).fill(0);
  let count7d = 0;
  for (const occurrence of occurrences) {
    const at = parseServerTime(occurrence.timestamp)?.getTime();
    if (at === undefined) continue;
    const age = Math.max(0, now - at);
    if (age < 7 * DAY) count7d += 1;
    if (age < DAY) hourly[23 - Math.floor(age / HOUR)] += 1;
  }
  return {
    count24h: hourly.reduce((sum, value) => sum + value, 0),
    count7d,
    lastSeen: occurrences[0]?.timestamp ?? null,
    firstSeen: occurrences.at(-1)?.timestamp ?? null,
    hourly,
  };
}

export interface EventNav {
  /** 0 is the latest event. -1 when the shown event is not in the list. */
  index: number;
  total: number;
  latest: string | null;
  newer: string | null;
  older: string | null;
  oldest: string | null;
}

/** Event ids for the Latest, Newer, Older and Oldest buttons; null where the button has nowhere to go. */
export function eventNav(occurrences: OccurrenceSummary[], currentEventId: string): EventNav {
  const total = occurrences.length;
  const index = occurrences.findIndex((occurrence) => occurrence.eventId === currentEventId);
  const at = (position: number) => (index >= 0 && position !== index ? occurrences[position]?.eventId ?? null : null);
  return {
    index,
    total,
    latest: index > 0 ? at(0) : null,
    newer: index > 0 ? at(index - 1) : null,
    older: index >= 0 && index < total - 1 ? at(index + 1) : null,
    oldest: index >= 0 && index < total - 1 ? at(total - 1) : null,
  };
}

export interface StatusAction {
  label: string;
  state: IssueState;
}

/**
 * The status buttons per state (plan D8). "Mark as open" exists only on reopened, because open and
 * reopened differ only in history and a closed issue goes back through Reopen.
 */
export function statusActions(state: IssueState): { primary: StatusAction; secondary: StatusAction | null } {
  if (state === "closed") return { primary: { label: "Reopen", state: "reopened" }, secondary: null };
  return {
    primary: { label: "Close issue", state: "closed" },
    secondary: state === "reopened" ? { label: "Mark as open", state: "open" } : null,
  };
}

/**
 * The state an Undo toast sends back: exactly the state the issue held before the change, or null when there
 * is nothing to undo (the caller did not know the previous state, or the change did not alter it). Not derived
 * from the new state: Close on a reopened issue and Close on an open one both land on closed, and only the
 * remembered state says which to return to.
 */
export function undoState(before: IssueState | undefined, after: IssueState): IssueState | null {
  return before && before !== after ? before : null;
}

/** JSON text that parses to an object or an array. Scalars and null are not structure, so they give undefined. */
export function parseJsonStructure(text: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // Not JSON text at all: the caller shows or ignores the original string.
    return undefined;
  }
}

/**
 * Raw fields may arrive as JSON text or as objects depending on the column; both read the same. The result is
 * only returned when it has the shape the caller reads, which the `fallback` says: an array fallback accepts
 * arrays, any other fallback accepts plain objects. JSON "null", "1", a string, or an array where an object
 * was expected is the sender's junk, and handing it back made `user.id` throw on null and blank the page.
 */
export function parseMaybeJson<T>(value: unknown, fallback: T): T {
  const structure = typeof value === "string" ? parseJsonStructure(value) : value !== null && typeof value === "object" ? value : undefined;
  return structure !== undefined && Array.isArray(structure) === Array.isArray(fallback) ? (structure as T) : fallback;
}

export function exceptionParts(exceptionInput: unknown): { type: string; value: string; mechanism: UnknownRecord | null } {
  const exception = parseMaybeJson<UnknownRecord>(exceptionInput, {});
  const values = Array.isArray(exception.values) ? (exception.values as UnknownRecord[]) : [];
  const primary = values[0] ?? exception;
  return {
    type: typeof primary.type === "string" ? primary.type : "Error",
    value: typeof primary.value === "string" ? primary.value : "No exception message",
    mechanism: primary.mechanism && typeof primary.mechanism === "object" ? (primary.mechanism as UnknownRecord) : null,
  };
}

export interface Frame {
  function?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  deobfuscated?: unknown;
}

/** Only object entries are frames; an SDK or a hostile sender can put null, numbers or strings in the list. */
function realFrames(entries: unknown[]): Frame[] {
  return entries.filter((entry): entry is Frame => entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

/**
 * Frames with the crash site first. SDKs send frames outermost first, so the crash site is the last one
 * (backend/src/lib/issue-sync.ts:51); reading top down should start where it broke. The event's own
 * stacktrace wins unless it is missing or empty, then the first exception value's, the same fallback the
 * GitHub issue body uses (issue-sync.ts:38-46), so both show the same frames.
 */
export function framesCrashFirst(stacktraceInput: unknown, exceptionInput: unknown): Frame[] {
  const stacktrace = parseMaybeJson<UnknownRecord | null>(stacktraceInput, null);
  let frames = stacktrace && Array.isArray(stacktrace.frames) ? realFrames(stacktrace.frames) : null;
  if (!frames || frames.length === 0) {
    const exception = parseMaybeJson<UnknownRecord>(exceptionInput, {});
    const values = Array.isArray(exception.values) ? (exception.values as UnknownRecord[]) : [];
    const nested = (values[0] ?? exception).stacktrace as UnknownRecord | undefined;
    frames = nested && Array.isArray(nested.frames) ? realFrames(nested.frames) : [];
  }
  return [...frames].reverse();
}

export const BREADCRUMB_PREVIEW = 7;

/**
 * The seven breadcrumbs just before the event, oldest first, so the list reads down to the error. The
 * server sends the newest 100 newest first (backend/src/routes/api.ts:881-882), so this flips the order
 * before taking the tail; slicing the server order directly showed the seven furthest from the crash.
 */
export function breadcrumbPreview(breadcrumbs: Breadcrumb[], showAll: boolean): Breadcrumb[] {
  const oldestFirst = [...breadcrumbs].reverse();
  return showAll ? oldestFirst : oldestFirst.slice(-BREADCRUMB_PREVIEW);
}

/**
 * A breadcrumb's distance from the error as the canvas draws it: "-8.4s" before, "0.0s" at, "+0.3s" after
 * (a breadcrumb can be stamped a hair after the event when the SDK and the capture disagree). Past a minute it
 * reads "-2m 05s", past an hour "-1h 05m". Rounds to tenths first and then picks the unit, so 59.96 s reads as
 * a minute and never as "-60.0s". Null when either time is unreadable, so the cell is left empty instead of
 * printing "NaN".
 */
export function breadcrumbOffset(crumbTime: string, eventTime: string): string | null {
  const crumb = parseServerTime(crumbTime)?.getTime();
  const event = parseServerTime(eventTime)?.getTime();
  if (crumb === undefined || event === undefined) return null;
  const tenths = Math.round(Math.abs(crumb - event) / 100);
  if (tenths === 0) return "0.0s";
  const sign = crumb < event ? "-" : "+";
  if (tenths < 600) return `${sign}${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(tenths / 10);
  if (seconds < 3600) return `${sign}${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${sign}${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** The event's level from the raw payload; ingest stores "error" when the SDK sent none (backend/src/lib/ingest.ts:210). */
export function eventLevel(rawPayload: string): string {
  const level = parseMaybeJson<UnknownRecord>(rawPayload, {}).level;
  return typeof level === "string" && level ? level.toLowerCase() : "error";
}

/**
 * A payload field as text. Objects and arrays are shown as their JSON, because String() on an object whose
 * toString is not callable (a sender writing {"toString":1}) throws and took the whole issue page down. null
 * and undefined are empty; everything else is a primitive and goes through String.
 */
export function displayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
