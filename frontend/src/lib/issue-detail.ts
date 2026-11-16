// Pure helpers for the issue detail page, kept out of the component so each rule has a test.
import type { Breadcrumb, DuplicateIssueGroup, EventNavigation, IssueState } from "@ekeeper/shared";
import { pluralize } from "./plural.ts";
import { formatRelative, parseServerTime } from "./time.ts";
import { formatNumber } from "./utils.ts";

type UnknownRecord = Record<string, unknown>;

/** Titles are always "<type>: <message>" (backend/src/lib/ingest.ts:191); a title without one renders whole. */
export function splitTitle(title: string): [string, string] {
  const index = title.indexOf(": ");
  return index > 0 ? [title.slice(0, index), title.slice(index + 2)] : [title, ""];
}

/** The 24 hourly bars and the tallest one. */
export interface HourlyChart {
  bars: number[];
  peak: number;
}

/**
 * The bars for "Events per hour, last 24h", or null when the server's array cannot be drawn honestly. The axis
 * and every bar's "Nh ago" tooltip assume exactly 24 slots, oldest first (`stats.hourly24h` in
 * shared/src/contracts.ts), so a shorter or longer array would label each bar with the wrong hour; the card
 * says the counts are unavailable instead of drawing a shifted chart. The bars come from the server, never from
 * a client side bucketing of event times, so they always add up to the "Events 24h" figure beside them.
 */
export function hourlyChart(hourly24h: readonly number[]): HourlyChart | null {
  if (!Array.isArray(hourly24h) || hourly24h.length !== 24 || !hourly24h.every((count) => Number.isFinite(count) && count >= 0)) {
    return null;
  }
  return { bars: [...hourly24h], peak: Math.max(...hourly24h) };
}

export interface EventNav {
  /** 1 is the newest event; null when the server's position is outside 1..total. */
  position: number | null;
  total: number | null;
  /** Event ids for the Latest, Newer, Older and Oldest buttons; null where the button has nowhere to go. */
  latest: string | null;
  newer: string | null;
  older: string | null;
  oldest: string | null;
}

/**
 * The event switcher from the server's `navigation` (shared/src/contracts.ts EventNavigation). Latest and
 * Oldest are disabled on the event they name, which is how the contract says to read them: they are always set
 * and equal the shown event at the edges. A missing `navigation` disables all four rather than guessing, and the
 * position reads "?" (the page never gets here with an event but no navigation, so this is the contract's own
 * null, not a state the server produces).
 */
export function eventNav(navigation: EventNavigation | null | undefined, currentEventId: string): EventNav {
  if (!navigation) return { position: null, total: null, latest: null, newer: null, older: null, oldest: null };
  const inRange = Number.isInteger(navigation.position) && navigation.position >= 1 && navigation.position <= navigation.total;
  return {
    position: inRange ? navigation.position : null,
    total: navigation.total,
    latest: navigation.latestEventId !== currentEventId ? navigation.latestEventId : null,
    newer: navigation.newerEventId,
    older: navigation.olderEventId,
    oldest: navigation.oldestEventId !== currentEventId ? navigation.oldestEventId : null,
  };
}

/**
 * "Closed 2h ago. Reopens on its own if a new event arrives." for a closed issue, null for any other state.
 * `closedAt` is the one time on this page that is ISO with a Z (the rest are zone-less ClickHouse digits);
 * parseServerTime reads both. The contract types closedAt as nullable even for a closed issue (the only writer,
 * backend/src/lib/issue-workflow.ts, always sets it when it closes one), so a missing or unreadable value
 * still says the issue reopens, just without the age, instead of printing "Closed never."
 */
export function closedNote(state: IssueState, closedAt: string | null, now: number): string | null {
  if (state !== "closed") return null;
  const closed = parseServerTime(closedAt) ? `Closed ${formatRelative(closedAt, now)}.` : "Closed.";
  return `${closed} Reopens on its own if a new event arrives.`;
}

/**
 * The line under a similar issue's title: "612 events · 201 users · release 2026.11.12-1". The release is left
 * out when the group's newest event had none (the server sends null, never ""), so the line never ends in
 * "release null".
 */
export function similarSummary(group: Pick<DuplicateIssueGroup, "events" | "affectedUsers" | "latestRelease">): string {
  const parts = [
    `${formatNumber(group.events)} ${pluralize(group.events, "event")}`,
    `${formatNumber(group.affectedUsers)} ${pluralize(group.affectedUsers, "user")}`,
  ];
  if (group.latestRelease) parts.push(`release ${group.latestRelease}`);
  return parts.join(" · ");
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

/**
 * One stack frame as stored. Every field is `unknown` because a public DSN can send any JSON: the SDK's
 * function, filename, lineno and colno, plus what the backend adds on read (`in_app: false` and `package` for
 * node_modules code, and the three source line fields on a source mapped frame, backend/src/lib/stack-frames.ts).
 * A reader checks the type of each field it uses (lib/stack-trace.ts does).
 */
export interface Frame {
  function?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  deobfuscated?: unknown;
  in_app?: unknown;
  package?: unknown;
  pre_context?: unknown;
  context_line?: unknown;
  post_context?: unknown;
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
