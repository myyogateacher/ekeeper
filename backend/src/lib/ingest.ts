import { createHash } from "node:crypto";
import type { Breadcrumb, NormalizedIngestEvent } from "@ekeeper/shared";
import { parseUserAgent, userAgentOf } from "./user-agent";

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const POINTER_PATTERN = /0x[0-9a-fA-F]{4,}/g;
const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const LONG_HEX_SEGMENT_PATTERN = /(^|\/)[0-9a-fA-F]{24,}(?=\/|$)/g;
const HASHED_ASSET_PATTERN = /([A-Za-z0-9_]+)-[A-Za-z0-9_-]{8,}(\.(?:m?js|css|map))\b/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>\\)]+/g;
const BRACE_OPEN_PLACEHOLDER = "";
const BRACE_CLOSE_PLACEHOLDER = "";

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const normalizedPath = url.pathname
      .replace(UUID_PATTERN, "_uuid_")
      .replace(LONG_HEX_SEGMENT_PATTERN, "$1_hash_")
      .replace(HASHED_ASSET_PATTERN, "$1-_hash_$2");
    return `${url.origin}${normalizedPath}`;
  } catch {
    return value
      .replace(UUID_PATTERN, "_uuid_")
      .replace(LONG_HEX_SEGMENT_PATTERN, "$1_hash_")
      .replace(HASHED_ASSET_PATTERN, "$1-_hash_$2");
  }
}

// Ingest is public to anyone holding a DSN and normalizeEvent runs on the single Bun event loop inside the
// buffer flush, so a crafted event must not cost more than a bounded amount of work. Two steps are quadratic
// in the length of what they read: HASHED_ASSET_PATTERN below (a 40k+40k character value took 2.4 s) and the
// nested-brace loop in normalizeExceptionValue, which runs on this function's output and is therefore bounded
// by it too (20k nested braces took 1.0 s). At 2048 characters the worst input costs a few milliseconds.
// Why 2048: the longest message among the 500 newest stored events across all projects was 255 characters
// (p99 114), so no real value is cut and no existing group splits. A value or frame filename that differs only
// after the cut (see capAtTokenBoundary) now shares a group, and its stored message and title are cut there. Same
// idea as the `.slice(-4)` on frames in computeGroupFingerprint, which already bounds what the fingerprint reads.
const MAX_NORMALIZED_TEXT_LENGTH = 2048;

// How far back from the cap capAtTokenBoundary looks for whitespace. Covers every token the patterns replace in
// practice: a UUID is 36 characters, a hex segment or hashed asset name well under 100, a URL path rarely over 256.
// A run with no spaces longer than this is far more likely a body (JSON, a URL query) than one token, and keeping
// its text separates errors that a cut back to the last space would merge.
const MAX_TOKEN_SCAN_BACK = 256;

// Cuts before the token that crosses the cap instead of through it. A UUID, hex segment or URL cut in half no
// longer matches the patterns in normalizeVolatileText, so two events differing only in that token would land in
// two groups where, uncut, they share one. Whitespace marks the token boundary because none of those patterns
// matches across it (URL_PATTERN stops at \s). With no whitespace in the last MAX_TOKEN_SCAN_BACK characters the
// value is cut at the cap: an unbounded scan would cut "Unexpected response: <JSON body with no spaces>" down to
// "Unexpected response:" and merge every such error into one group with no detail left. The cut position still
// moves when a volatile token before it varies in length (a query string normalizeUrl drops, a pointer's digit
// count), so values over the cap can split on that; none are seen today (longest stored value 255 characters).
// A backwards scan rather than a regex like /\S*$/, which backtracks quadratically on a long run of non-space
// characters.
function capAtTokenBoundary(raw: string): string {
  if (raw.length <= MAX_NORMALIZED_TEXT_LENGTH) {
    return raw;
  }
  const floor = MAX_NORMALIZED_TEXT_LENGTH - MAX_TOKEN_SCAN_BACK;
  let end = MAX_NORMALIZED_TEXT_LENGTH;
  while (end > floor && !/\s/.test(raw[end])) {
    end -= 1;
  }
  return raw.slice(0, /\s/.test(raw[end]) ? end : MAX_NORMALIZED_TEXT_LENGTH);
}

function normalizeVolatileText(raw: string): string {
  return capAtTokenBoundary(raw)
    .replace(POINTER_PATTERN, "0x_")
    .replace(URL_PATTERN, (url) => normalizeUrl(url))
    .replace(UUID_PATTERN, "_uuid_")
    .replace(LONG_HEX_SEGMENT_PATTERN, "$1_hash_")
    .replace(HASHED_ASSET_PATTERN, "$1-_hash_$2");
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{" || ch === BRACE_OPEN_PLACEHOLDER) {
      depth += 1;
    } else if (ch === "}" || ch === BRACE_CLOSE_PLACEHOLDER) {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function normalizeExceptionValue(raw: string): string {
  if (!raw) {
    return raw;
  }
  let s = normalizeVolatileText(raw);

  let previous = "";
  while (previous !== s) {
    previous = s;
    s = s.replace(/\{([^{}]*)\}/g, (_, inner: string) => {
      const sorted = splitTopLevelCommas(inner).sort();
      return BRACE_OPEN_PLACEHOLDER + sorted.join(", ") + BRACE_CLOSE_PLACEHOLDER;
    });
  }

  return s.replaceAll(BRACE_OPEN_PLACEHOLDER, "{").replaceAll(BRACE_CLOSE_PLACEHOLDER, "}");
}

// String(value) that cannot throw. Every field of an event is attacker-controlled JSON (ingest is public to anyone
// holding a DSN), and String() throws on two shapes that JSON.parse produces: an object whose own "toString" is not a
// function (`{"toString":1}`, "No default value"), and an array nested deep enough to overflow the stack in
// Array#toString (measured on bun 1.4.2: 2000 levels pass, 5000 throw). JSON.parse and JSON.stringify both still
// succeed at 20000 levels, so such a value gets past enqueue. A throw in normalizeEvent aborts the whole project batch
// in the buffer flush (PROD-10530), so one unusable field must cost only that field. The result for every value that
// did not throw is exactly String(value): this must not change any stored title or group, so no existing group splits.
function safeString<F extends string | null>(value: unknown, fallback: F): string | F {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function normalizeBreadcrumbs(value: unknown): Breadcrumb[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray((value as { values?: unknown[] } | null)?.values)
      ? ((value as { values?: unknown[] }).values ?? [])
      : [];

  return source.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    return {
      timestamp: safeString(entry.timestamp ?? now, now),
      category: safeString(entry.category ?? "default", "default"),
      level: safeString(entry.level ?? "info", "info"),
      message: safeString(entry.message ?? "", ""),
      type: safeString(entry.type ?? "default", "default"),
      data: (entry.data as Record<string, unknown>) ?? {},
    };
  });
}

function extractStacktrace(exceptionValue: Record<string, unknown>): Record<string, unknown> | null {
  if (!exceptionValue || typeof exceptionValue !== "object") {
    return null;
  }

  if (typeof exceptionValue.stacktrace === "object" && exceptionValue.stacktrace) {
    return exceptionValue.stacktrace as Record<string, unknown>;
  }

  const values = Array.isArray(exceptionValue.values) ? (exceptionValue.values as Record<string, unknown>[]) : [];
  const first = values[0] ?? {};
  return (first.stacktrace as Record<string, unknown>) ?? null;
}

export function computeGroupFingerprint(payload: Record<string, unknown>): string {
  const explicitFingerprint = Array.isArray(payload.fingerprint)
    ? payload.fingerprint.filter((item): item is string => typeof item === "string")
    : [];

  if (explicitFingerprint.length > 0) {
    return explicitFingerprint.join(":");
  }

  const exceptionValues = Array.isArray((payload.exception as Record<string, unknown> | undefined)?.values)
    ? (((payload.exception as Record<string, unknown>).values as unknown[]) as Array<Record<string, unknown>>)
    : [];
  const exception = exceptionValues[0] ?? {};
  const type = safeString(exception.type ?? "Error", "Error");
  const value = normalizeExceptionValue(
    safeString(exception.value ?? payload.message ?? "Unknown error", "Unknown error"),
  );
  // `frames` is client data: a string, object or number has no .map, and a null element has no .filename, so each of
  // those threw here and stalled the flush. A null frame reads as an empty one, which contributes "" to its slot in the
  // join exactly as a frame with neither filename nor function always did.
  const rawFrames = (exception.stacktrace as Record<string, unknown> | undefined)?.frames;
  const frames = (Array.isArray(rawFrames) ? rawFrames : [])
    .slice(-4)
    .map((frame: Record<string, unknown> | null) => {
      const { filename, function: functionName } = frame ?? {};
      // join() would call String() on each part and throw on the shapes safeString documents, so convert here.
      return [typeof filename === "string" ? normalizeVolatileText(filename) : filename, functionName]
        .filter(Boolean)
        .map((part) => safeString(part, ""))
        .join(":");
    })
    .join("|");

  return hashString(`${type}|${value}|${frames}`).slice(0, 32);
}

export function normalizeEvent(projectId: string, payload: Record<string, unknown>): NormalizedIngestEvent {
  const exceptionValues = Array.isArray((payload.exception as Record<string, unknown> | undefined)?.values)
    ? (((payload.exception as Record<string, unknown>).values as unknown[]) as Array<Record<string, unknown>>)
    : [];
  const primaryException = exceptionValues[0] ?? {};
  const message = normalizeExceptionValue(
    safeString(primaryException.value ?? payload.message ?? "Unknown error", "Unknown error"),
  );
  const exceptionType = safeString(primaryException.type ?? "Error", "Error");
  const title = `${exceptionType}: ${message}`;
  const fingerprint = computeGroupFingerprint(payload);
  const contexts = (payload.contexts as Record<string, unknown>) ?? {};
  const user = (payload.user as Record<string, unknown>) ?? {};
  const browserContext = (contexts.browser as Record<string, unknown>) ?? {};
  const deviceContext = (contexts.device as Record<string, unknown>) ?? {};
  const osContext = (contexts.os as Record<string, unknown>) ?? {};
  const runtimeContext = (contexts.runtime as Record<string, unknown>) ?? {};
  const breadcrumbs = normalizeBreadcrumbs(payload.breadcrumbs);
  // Per field, not all or nothing: an event that sends only `contexts.os` still gets its browser from the UA.
  const fromUserAgent = parseUserAgent(userAgentOf(payload.request));
  const now = new Date().toISOString();
  const generatedEventId = crypto.randomUUID().replace(/-/g, "");
  const eventId = safeString(payload.event_id ?? generatedEventId, generatedEventId);

  return {
    eventId,
    projectId,
    groupId: fingerprint,
    fingerprint,
    title,
    message,
    severity: safeString(payload.level ?? "error", "error"),
    timestamp: safeString(payload.timestamp ?? now, now),
    release: payload.release ? safeString(payload.release, null) : null,
    environment: payload.environment ? safeString(payload.environment, null) : null,
    userId: user.id ? safeString(user.id, null) : null,
    userEmail: user.email ? safeString(user.email, null) : null,
    userUsername: user.username ? safeString(user.username, null) : null,
    // A name that cannot be read as text falls back to the User-Agent, the same as an absent one.
    browser: browserContext.name ? safeString(browserContext.name, fromUserAgent.browser) : fromUserAgent.browser,
    device: deviceContext.model
      ? safeString(deviceContext.model, fromUserAgent.device)
      : deviceContext.family
        ? safeString(deviceContext.family, fromUserAgent.device)
        : fromUserAgent.device,
    os: osContext.name ? safeString(osContext.name, fromUserAgent.os) : fromUserAgent.os,
    runtime: runtimeContext.name ? safeString(runtimeContext.name, null) : null,
    tags: Object.fromEntries(
      Object.entries((payload.tags as Record<string, unknown>) ?? {}).map(([key, value]) => [key, safeString(value, "")]),
    ),
    contexts,
    exception: (payload.exception as Record<string, unknown>) ?? {},
    stacktrace: extractStacktrace(payload.exception as Record<string, unknown>),
    breadcrumbs,
    rawPayload: JSON.stringify(payload),
  };
}

export function parseEnvelope(raw: string): Record<string, unknown>[] {
  const lines = raw.split("\n");
  const payloads: Record<string, unknown>[] = [];
  let index = 0;

  if (lines.length === 0) {
    return payloads;
  }

  index += 1;
  while (index < lines.length) {
    const itemHeaderLine = lines[index]?.trim();
    index += 1;

    if (!itemHeaderLine) {
      continue;
    }

    const itemHeader = JSON.parse(itemHeaderLine) as { type?: string; length?: number };
    const bodyLines: string[] = [];

    while (index < lines.length && lines[index]?.trim() !== "") {
      bodyLines.push(lines[index] ?? "");
      index += 1;
      if (itemHeader.length && bodyLines.join("\n").length >= itemHeader.length) {
        break;
      }
    }

    while (index < lines.length && lines[index]?.trim() === "") {
      index += 1;
    }

    if (itemHeader.type === "event" || itemHeader.type === "transaction" || itemHeader.type === "default") {
      const body = bodyLines.join("\n").trim();
      if (body) {
        payloads.push(JSON.parse(body) as Record<string, unknown>);
      }
    }
  }

  return payloads;
}
