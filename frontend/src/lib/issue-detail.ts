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

/** Raw fields may arrive as JSON text or as objects depending on the column; both read the same. */
export function parseMaybeJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" ? (value as T) : fallback;
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

/**
 * Frames with the crash site first. SDKs send frames outermost first, so the crash site is the last one
 * (backend/src/lib/issue-sync.ts:51); reading top down should start where it broke. The event's own
 * stacktrace wins unless it is missing or empty, then the first exception value's, the same fallback the
 * GitHub issue body uses (issue-sync.ts:38-46), so both show the same frames.
 */
export function framesCrashFirst(stacktraceInput: unknown, exceptionInput: unknown): Frame[] {
  const stacktrace = parseMaybeJson<UnknownRecord | null>(stacktraceInput, null);
  let frames = stacktrace && Array.isArray(stacktrace.frames) ? (stacktrace.frames as Frame[]) : null;
  if (!frames || frames.length === 0) {
    const exception = parseMaybeJson<UnknownRecord>(exceptionInput, {});
    const values = Array.isArray(exception.values) ? (exception.values as UnknownRecord[]) : [];
    const nested = (values[0] ?? exception).stacktrace as UnknownRecord | undefined;
    frames = nested && Array.isArray(nested.frames) ? (nested.frames as Frame[]) : [];
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

/** The event's level from the raw payload; ingest stores "error" when the SDK sent none (backend/src/lib/ingest.ts:210). */
export function eventLevel(rawPayload: string): string {
  const level = parseMaybeJson<UnknownRecord>(rawPayload, {}).level;
  return typeof level === "string" && level ? level.toLowerCase() : "error";
}
