import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { HiArrowDownTray, HiChevronLeft, HiChevronRight } from "react-icons/hi2";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { IssueState } from "@ekeeper/shared";

type UnknownRecord = Record<string, unknown>;

function parseMaybeJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  if (value && typeof value === "object") {
    return value as T;
  }

  return fallback;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Unknown";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function normalizeStructuredValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return normalizeStructuredValue(JSON.parse(value));
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeStructuredValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as UnknownRecord).map(([key, nestedValue]) => [key, normalizeStructuredValue(nestedValue)]),
    );
  }

  return value;
}

function renderKeyValueList(record: UnknownRecord, valueClassName = "break-all text-slate-200") {
  return Object.entries(record).map(([key, currentValue]) => (
    <div key={key} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-slate-400">{key}</span>
      {(() => {
        const normalizedValue = normalizeStructuredValue(currentValue);

        if (normalizedValue && typeof normalizedValue === "object" && !Array.isArray(normalizedValue)) {
          return (
        <div className="rounded-2xl border border-white/10 bg-slate-950/20 p-3">
          <div className="grid gap-2">
                {Object.entries(normalizedValue as UnknownRecord).map(([nestedKey, nestedValue]) => (
              <div key={nestedKey} className="flex min-w-0 flex-col gap-1 text-xs">
                <span className="text-slate-500">{nestedKey}</span>
                <span className={`break-all ${valueClassName}`}>{displayValue(nestedValue)}</span>
              </div>
            ))}
          </div>
        </div>
          );
        }

        if (Array.isArray(normalizedValue)) {
          return (
            <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/20 p-3 text-xs text-slate-200">
              {JSON.stringify(normalizedValue, null, 2)}
            </pre>
          );
        }

        return <span className={valueClassName}>{displayValue(normalizedValue)}</span>;
      })()}
    </div>
  ));
}

function getExceptionParts(exceptionInput: unknown) {
  const exception = parseMaybeJson<UnknownRecord>(exceptionInput, {});
  const values = Array.isArray(exception.values) ? (exception.values as UnknownRecord[]) : [];
  const primary = values[0] ?? exception;

  return {
    exception,
    primary,
    type: typeof primary.type === "string" ? primary.type : "Error",
    value: typeof primary.value === "string" ? primary.value : "No exception message",
    mechanism:
      primary.mechanism && typeof primary.mechanism === "object"
        ? (primary.mechanism as UnknownRecord)
        : null,
  };
}

function getFrames(stacktraceInput: unknown, exceptionInput: unknown) {
  const parsedStacktrace = parseMaybeJson<UnknownRecord | null>(stacktraceInput, null);
  const fromStacktrace = parsedStacktrace && Array.isArray(parsedStacktrace.frames)
    ? (parsedStacktrace.frames as UnknownRecord[])
    : null;

  if (fromStacktrace) {
    return fromStacktrace;
  }

  const { primary } = getExceptionParts(exceptionInput);
  const nested = primary.stacktrace && typeof primary.stacktrace === "object"
    ? (primary.stacktrace as UnknownRecord)
    : null;

  return nested && Array.isArray(nested.frames) ? (nested.frames as UnknownRecord[]) : [];
}

export function ErrorDetailPage() {
  const { projectId = "", groupId = "" } = useParams();
  const queryClient = useQueryClient();
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(undefined);
  const { data, isFetching } = useQuery({
    queryKey: ["error-detail", projectId, groupId, selectedEventId],
    queryFn: () => api.errorDetail(projectId, groupId, selectedEventId),
    enabled: Boolean(projectId && groupId),
    placeholderData: (previousData) => previousData,
  });
  const { data: assignees } = useQuery({
    queryKey: ["error-assignees", projectId],
    queryFn: () => api.errorAssignees(projectId),
    enabled: Boolean(projectId),
  });

  const workflowMutation = useMutation({
    mutationFn: (payload: { state?: IssueState; assignedUserId?: string | null }) =>
      api.updateIssueWorkflow(projectId, groupId, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["error-detail", projectId, groupId] }),
        queryClient.invalidateQueries({ queryKey: ["errors"] }),
      ]);
    },
  });

  const error = data?.error;
  const occurrences = data?.occurrences ?? [];
  const totalOccurrences = occurrences.length;
  const currentIndex = error
    ? occurrences.findIndex((o) => o.eventId === error.eventId)
    : 0;

  function goToOccurrence(index: number) {
    const target = occurrences[index];
    if (target) {
      setSelectedEventId(target.eventId);
    }
  }

  if (!error) {
    return (
      <div className="glass-panel p-6">
        <h2 className="text-2xl font-semibold text-white">No error detail available</h2>
      </div>
    );
  }

  const currentError = error;

  const { primary, type, value, mechanism } = getExceptionParts(currentError.exception);
  const frames = getFrames(currentError.stacktrace, currentError.exception);
  const tags = parseMaybeJson<Record<string, string>>(currentError.tags, {});
  const contexts = parseMaybeJson<UnknownRecord>(currentError.contexts, {});
  const rawEvent = parseMaybeJson<UnknownRecord>(currentError.rawPayload, {});
  const request = parseMaybeJson<UnknownRecord>((parseMaybeJson<UnknownRecord>(currentError.rawPayload, {})).request, {});
  const requestHeaders =
    request.headers && typeof request.headers === "object" ? (request.headers as UnknownRecord) : {};
  const contextEntries = Object.entries(contexts).filter(([key]) => key !== "trace");
  const rawExtra = rawEvent.extra && typeof rawEvent.extra === "object" ? (normalizeStructuredValue(rawEvent.extra) as UnknownRecord) : {};
  const rawTags = rawEvent.tags && typeof rawEvent.tags === "object" ? (normalizeStructuredValue(rawEvent.tags) as UnknownRecord) : tags;
  const rawUser = rawEvent.user && typeof rawEvent.user === "object" ? (normalizeStructuredValue(rawEvent.user) as UnknownRecord) : {};
  const normalizedBreadcrumbs = currentError.breadcrumbs.map((breadcrumb) => ({
    ...breadcrumb,
    data: normalizeStructuredValue(breadcrumb.data),
  }));
  const parsedRawEvent = rawEvent;

  function downloadRawEvent() {
    const blob = new Blob([JSON.stringify(parsedRawEvent, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `event-${currentError.eventId || currentError.groupId}.json`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <div className="min-w-0 space-y-6">
      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Issue detail</p>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-3xl font-semibold text-white">{error.message}</h2>
            <p className="mt-2 text-sm text-slate-300">
              {type} • Event captured {formatDate(error.timestamp)}
              {totalOccurrences > 0 ? ` • ${totalOccurrences} occurrence${totalOccurrences === 1 ? "" : "s"} total` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {totalOccurrences > 1 ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="button-secondary h-9 w-9 !p-0 disabled:opacity-30"
                  disabled={currentIndex <= 0}
                  onClick={() => goToOccurrence(currentIndex - 1)}
                  aria-label="Newer occurrence"
                >
                  <HiChevronLeft className="mx-auto h-4 w-4" />
                </button>
                <span className={`min-w-[5rem] text-center text-sm text-slate-300 ${isFetching ? "animate-pulse" : ""}`}>
                  {currentIndex + 1} / {totalOccurrences}
                </span>
                <button
                  type="button"
                  className="button-secondary h-9 w-9 !p-0 disabled:opacity-30"
                  disabled={currentIndex >= totalOccurrences - 1}
                  onClick={() => goToOccurrence(currentIndex + 1)}
                  aria-label="Older occurrence"
                >
                  <HiChevronRight className="mx-auto h-4 w-4" />
                </button>
              </div>
            ) : null}
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
              Group <span className="font-mono text-xs">{error.groupId}</span>
            </div>
          </div>
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">State</p>
            <select
              className="input mt-3"
              value={error.state}
              onChange={(event) =>
                workflowMutation.mutate({ state: event.target.value as IssueState })
              }
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="reopened">Reopened</option>
            </select>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Assigned team member</p>
            <select
              className="input mt-3"
              value={error.assignedUserId ?? ""}
              onChange={(event) =>
                workflowMutation.mutate({ assignedUserId: event.target.value || null })
              }
            >
              <option value="">Unassigned</option>
              {(assignees?.users ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Workflow</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {error.state === "closed" ? (
                <button className="button-secondary" onClick={() => workflowMutation.mutate({ state: "reopened" })}>
                  Reopen
                </button>
              ) : (
                <button className="button-primary" onClick={() => workflowMutation.mutate({ state: "closed" })}>
                  Close issue
                </button>
              )}
            </div>
            <p className="mt-3 text-sm text-slate-300">
              Assigned to {error.assignedUserName ?? "nobody"} • currently {error.state}.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a className="button-secondary" href="#stacktrace">
            Jump to stack trace
          </a>
          <a className="button-secondary" href="#breadcrumbs">
            Jump to breadcrumbs
          </a>
          <button className="button-secondary gap-2" type="button" onClick={downloadRawEvent}>
            <HiArrowDownTray className="h-4 w-4" />
            Download raw event
          </button>
        </div>
        {error.sourceMapApplied ? (
          <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
            Source maps were applied to this event using release {error.sourceMapRelease ?? "unknown"}.
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/20 px-4 py-3 text-sm text-slate-300">
            No matching minimap was found for this event, so stack frames are shown in their raw uploaded form.
          </div>
        )}
      </section>

      <section className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="min-w-0 space-y-6">
          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Request</h3>
            <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 rounded-3xl border border-white/10 bg-slate-950/20 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-400">URL</p>
                <p className="mt-2 break-all text-sm text-slate-200">{displayValue(request.url)}</p>
              </div>
              <div className="min-w-0 rounded-3xl border border-white/10 bg-slate-950/20 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Headers</p>
                <div className="mt-3 space-y-2">
                  {Object.keys(requestHeaders).length > 0 ? (
                    renderKeyValueList(requestHeaders)
                  ) : (
                    <p className="text-sm text-slate-300">No request headers available.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Exception</h3>
            <div className="mt-4 min-w-0 rounded-3xl border border-white/10 bg-slate-950/20 p-5">
              <p className="text-sm uppercase tracking-[0.22em] text-slate-400">Type</p>
              <p className="mt-2 text-xl font-semibold text-white">{type}</p>
              <p className="mt-4 text-sm uppercase tracking-[0.22em] text-slate-400">Message</p>
              <p className="mt-2 text-sm leading-6 text-slate-200">{value}</p>
              {mechanism ? (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {Object.entries(mechanism).map(([key, mechanismValue]) => (
                    <div key={key} className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{key}</p>
                      <div className="mt-2 min-w-0">
                        {mechanismValue && typeof mechanismValue === "object" && !Array.isArray(mechanismValue) ? (
                          <div className="grid gap-2">
                            {renderKeyValueList(mechanismValue as UnknownRecord, "text-slate-200")}
                          </div>
                        ) : (
                          <p className="break-words text-sm text-slate-200">{displayValue(mechanismValue)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div id="stacktrace" className="glass-panel min-w-0 scroll-mt-6 p-6">
            <h3 className="text-lg font-semibold text-white">Stack frames</h3>
            <div className="mt-4 space-y-3">
              {frames.length > 0 ? (
                frames.map((frame, index) => (
                  <div key={`${String(frame.filename ?? "frame")}-${index}`} className="min-w-0 rounded-3xl border border-white/10 bg-slate-950/20 p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-semibold text-white">
                          {displayValue(frame.function ?? "?")}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-cyan-100/80">
                          {displayValue(frame.filename ?? "unknown source")}
                        </p>
                        {frame.deobfuscated ? (
                          <p className="mt-2 inline-flex rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-emerald-100">
                            Deobfuscated
                          </p>
                        ) : null}
                      </div>
                      <div className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                        line {displayValue(frame.lineno ?? "?")} • col {displayValue(frame.colno ?? "?")}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-4 text-sm text-slate-300">
                  No parsed stack frames available for this event.
                </div>
              )}
            </div>
          </div>

          <div id="breadcrumbs" className="glass-panel min-w-0 scroll-mt-6 p-6">
            <h3 className="text-lg font-semibold text-white">Breadcrumbs</h3>
            <div className="mt-4 space-y-3">
              {normalizedBreadcrumbs.length > 0 ? (
                normalizedBreadcrumbs.map((breadcrumb, index) => (
                  <div key={`${breadcrumb.timestamp}-${index}`} className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <p className="font-medium text-white">{breadcrumb.category}</p>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{breadcrumb.level}</p>
                    </div>
                    <p className="mt-2 text-sm text-slate-300">{breadcrumb.message}</p>
                    {breadcrumb.data &&
                    typeof breadcrumb.data === "object" &&
                    !Array.isArray(breadcrumb.data) &&
                    Object.keys(breadcrumb.data as UnknownRecord).length > 0 ? (
                      <div className="mt-3 grid gap-2">
                        {Object.entries(breadcrumb.data as UnknownRecord).map(([key, dataValue]) => {
                          const normalizedValue = normalizeStructuredValue(dataValue);

                          if (normalizedValue && typeof normalizedValue === "object") {
                            return (
                              <div key={key} className="flex min-w-0 flex-col gap-1 text-xs">
                                <span className="text-slate-400">{key}</span>
                                <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/20 p-3 text-xs text-slate-200">
                                  {JSON.stringify(normalizedValue, null, 2)}
                                </pre>
                              </div>
                            );
                          }

                          return (
                            <div key={key} className="flex min-w-0 flex-col gap-1 text-xs">
                              <span className="text-slate-400">{key}</span>
                              <span className="break-all text-slate-200">{displayValue(normalizedValue)}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : Array.isArray(breadcrumb.data) ? (
                      <div className="mt-3">
                        <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/20 p-3 text-xs text-slate-200">
                          {JSON.stringify(breadcrumb.data, null, 2)}
                        </pre>
                      </div>
                    ) : breadcrumb.data ? (
                      <div className="mt-3 flex min-w-0 flex-col gap-1 text-xs">
                        <span className="text-slate-400">data</span>
                        <span className="break-all text-slate-200">{displayValue(breadcrumb.data)}</span>
                      </div>
                    ) : null}
                    <p className="mt-3 text-xs text-slate-400">{formatDate(breadcrumb.timestamp)}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-300">No breadcrumbs captured.</p>
              )}
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Runtime context</h3>
            <dl className="mt-4 space-y-3 text-sm text-slate-300">
              <div className="flex justify-between gap-4">
                <dt>Browser</dt>
                <dd>{error.browser ?? "Unknown"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Device</dt>
                <dd>{error.device ?? "Unknown"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>OS</dt>
                <dd>{error.os ?? "Unknown"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Runtime</dt>
                <dd>{error.runtime ?? "Unknown"}</dd>
              </div>
            </dl>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">User</h3>
            <div className="mt-4 space-y-2">
              {Object.keys(rawUser).length > 0 ? (
                renderKeyValueList(rawUser)
              ) : (
                <p className="text-sm text-slate-300">No user context captured.</p>
              )}
            </div>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Tags</h3>
            <div className="mt-4 space-y-2">
              {Object.keys(rawTags).length > 0 ? (
                renderKeyValueList(rawTags)
              ) : (
                <p className="text-sm text-slate-300">No tags captured.</p>
              )}
            </div>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Extra</h3>
            <div className="mt-4 space-y-2">
              {Object.keys(rawExtra).length > 0 ? (
                renderKeyValueList(rawExtra)
              ) : (
                <p className="text-sm text-slate-300">No extra payload captured.</p>
              )}
            </div>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Contexts</h3>
            <div className="mt-4 space-y-3">
              {contextEntries.length > 0 ? (
                contextEntries.map(([key, contextValue]) => (
                  <div key={key} className="min-w-0 rounded-3xl border border-white/10 bg-slate-950/20 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-400">{key}</p>
                    <div className="mt-3 space-y-2">
                      {contextValue && typeof contextValue === "object" ? (
                        renderKeyValueList(contextValue as UnknownRecord)
                      ) : (
                        <p className="text-sm text-slate-200">{displayValue(contextValue)}</p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-300">No additional contexts captured.</p>
              )}
            </div>
          </div>

          <div className="glass-panel min-w-0 p-6">
            <h3 className="text-lg font-semibold text-white">Raw event</h3>
            <pre className="mt-4 overflow-x-auto rounded-3xl border border-white/10 bg-slate-950/20 p-4 text-xs text-slate-300">
              {JSON.stringify(parsedRawEvent, null, 2)}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
