import { createHash } from "node:crypto";
import type { Breadcrumb, NormalizedIngestEvent } from "@ekeeper/shared";

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

function normalizeVolatileText(raw: string): string {
  return raw
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

function normalizeBreadcrumbs(value: unknown): Breadcrumb[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray((value as { values?: unknown[] } | null)?.values)
      ? ((value as { values?: unknown[] }).values ?? [])
      : [];

  return source.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return {
      timestamp: String(entry.timestamp ?? new Date().toISOString()),
      category: String(entry.category ?? "default"),
      level: String(entry.level ?? "info"),
      message: String(entry.message ?? ""),
      type: String(entry.type ?? "default"),
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
  const type = String(exception.type ?? "Error");
  const value = normalizeExceptionValue(String(exception.value ?? payload.message ?? "Unknown error"));
  const frames = (((exception.stacktrace as Record<string, unknown> | undefined)?.frames ?? []) as Array<
    Record<string, unknown>
  >)
    .slice(-4)
    .map((frame) =>
      [
        typeof frame.filename === "string" ? normalizeVolatileText(frame.filename) : frame.filename,
        frame.function,
      ].filter(Boolean).join(":"),
    )
    .join("|");

  return hashString(`${type}|${value}|${frames}`).slice(0, 32);
}

export function normalizeEvent(projectId: string, payload: Record<string, unknown>): NormalizedIngestEvent {
  const exceptionValues = Array.isArray((payload.exception as Record<string, unknown> | undefined)?.values)
    ? (((payload.exception as Record<string, unknown>).values as unknown[]) as Array<Record<string, unknown>>)
    : [];
  const primaryException = exceptionValues[0] ?? {};
  const message = normalizeExceptionValue(
    String(primaryException.value ?? payload.message ?? "Unknown error"),
  );
  const exceptionType = String(primaryException.type ?? "Error");
  const title = `${exceptionType}: ${message}`;
  const fingerprint = computeGroupFingerprint(payload);
  const contexts = (payload.contexts as Record<string, unknown>) ?? {};
  const user = (payload.user as Record<string, unknown>) ?? {};
  const browserContext = (contexts.browser as Record<string, unknown>) ?? {};
  const deviceContext = (contexts.device as Record<string, unknown>) ?? {};
  const osContext = (contexts.os as Record<string, unknown>) ?? {};
  const runtimeContext = (contexts.runtime as Record<string, unknown>) ?? {};
  const breadcrumbs = normalizeBreadcrumbs(payload.breadcrumbs);

  return {
    eventId: String(payload.event_id ?? crypto.randomUUID().replace(/-/g, "")),
    projectId,
    groupId: fingerprint,
    fingerprint,
    title,
    message,
    severity: String(payload.level ?? "error"),
    timestamp: String(payload.timestamp ?? new Date().toISOString()),
    release: payload.release ? String(payload.release) : null,
    environment: payload.environment ? String(payload.environment) : null,
    userId: user.id ? String(user.id) : null,
    userEmail: user.email ? String(user.email) : null,
    userUsername: user.username ? String(user.username) : null,
    browser: browserContext.name ? String(browserContext.name) : null,
    device: deviceContext.model ? String(deviceContext.model) : deviceContext.family ? String(deviceContext.family) : null,
    os: osContext.name ? String(osContext.name) : null,
    runtime: runtimeContext.name ? String(runtimeContext.name) : null,
    tags: Object.fromEntries(
      Object.entries((payload.tags as Record<string, unknown>) ?? {}).map(([key, value]) => [key, String(value)]),
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
