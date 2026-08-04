import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { formatDate, formatNumber } from "@/lib/utils";

const PAGE_SIZE = 25;

const RANGE_PRESETS = [
  { id: "24h", label: "24h", hours: 24 },
  { id: "7d", label: "7d", hours: 24 * 7 },
  { id: "14d", label: "14d", hours: 24 * 14 },
  { id: "30d", label: "30d", hours: 24 * 30 },
  { id: "all", label: "All time", hours: null },
] as const;

type RangePresetId = (typeof RANGE_PRESETS)[number]["id"];

const DEFAULT_RANGE_PRESET: RangePresetId = "7d";

/** Returns the ISO `from` boundary for a preset, or "" for the unbounded "All time" preset. */
function presetFrom(id: RangePresetId): string {
  const hours = RANGE_PRESETS.find((preset) => preset.id === id)?.hours ?? null;
  return hours === null ? "" : new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

const SEVERITY_TONES: Record<string, string> = {
  fatal: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  critical: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  error: "border-orange-400/30 bg-orange-400/10 text-orange-200",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  info: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  debug: "border-white/10 bg-white/5 text-slate-300",
};

const STATE_TONES: Record<string, string> = {
  open: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  reopened: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  closed: "border-white/10 bg-white/5 text-slate-400",
};

function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

export function ErrorsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projectId, setProjectId] = useState(() => searchParams.get("projectId") ?? "");
  const [assignmentFilter, setAssignmentFilter] = useState("any");
  const [state, setState] = useState("open_or_reopened");
  const [userInput, setUserInput] = useState(() => searchParams.get("user") ?? "");
  const [userFilter, setUserFilter] = useState(() => searchParams.get("user") ?? "");
  const [page, setPage] = useState(0);
  // The listing defaults to the last 7 days; "All time" or a custom range widens it.
  const [rangePreset, setRangePreset] = useState<RangePresetId | "custom">(DEFAULT_RANGE_PRESET);
  const [rangeFrom, setRangeFrom] = useState(() => presetFrom(DEFAULT_RANGE_PRESET));
  const [rangeTo, setRangeTo] = useState("");
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const { data: assignees } = useQuery({
    queryKey: ["error-assignees", projectId || "all"],
    queryFn: () => api.errorAssignees(projectId || undefined),
  });
  const { data } = useQuery({
    queryKey: ["errors", projectId || "all", assignmentFilter, state, userFilter, rangeFrom, rangeTo, page],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.errors(projectId || undefined, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        from: rangeFrom || undefined,
        to: rangeTo || undefined,
        state,
        assignment:
          assignmentFilter === "any" || assignmentFilter === "assigned" || assignmentFilter === "unassigned"
            ? assignmentFilter
            : "user",
        assignedUserId:
          assignmentFilter !== "any" && assignmentFilter !== "assigned" && assignmentFilter !== "unassigned"
            ? assignmentFilter
            : undefined,
        user: userFilter || undefined,
      }),
  });

  const projectOptions = useMemo(() => projects?.projects ?? [], [projects]);
  const assigneeOptions = useMemo(() => assignees?.users ?? [], [assignees]);
  const projectNameById = useMemo(
    () => new Map(projectOptions.map((project) => [project.id, project.name])),
    [projectOptions],
  );

  const errors = data?.errors ?? [];
  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);

  // Snap back to the last valid page when the total shrinks (for example after issues close).
  useEffect(() => {
    if (total > 0 && page > 0 && page * PAGE_SIZE >= total) {
      setPage(Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0));
    }
  }, [total, page]);

  useEffect(() => {
    const nextProjectId = searchParams.get("projectId") ?? "";
    if (nextProjectId !== projectId) {
      setProjectId(nextProjectId);
    }
  }, [projectId, searchParams]);

  function handleProjectChange(nextProjectId: string) {
    setProjectId(nextProjectId);
    setPage(0);
    const nextParams = new URLSearchParams(searchParams);
    if (nextProjectId) {
      nextParams.set("projectId", nextProjectId);
    } else {
      nextParams.delete("projectId");
    }
    setSearchParams(nextParams, { replace: true });
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel flex flex-col gap-4 p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Error explorer</p>
          <h2 className="mt-4 text-3xl font-semibold text-white">Grouped failures across projects</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Track recurrence, first and last seen windows, and drill into stack traces with runtime context.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="min-w-0">
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Project</label>
            <select className="input" value={projectId} onChange={(event) => handleProjectChange(event.target.value)}>
              <option value="">All projects</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">State</label>
            <select
              className="input"
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                setPage(0);
              }}
            >
              <option value="open_or_reopened">Open + reopened</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="reopened">Reopened</option>
              <option value="any">Any</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Assignment</label>
            <select
              className="input"
              value={assignmentFilter}
              onChange={(event) => {
                setAssignmentFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="any">Any assignment</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
              {assigneeOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">User</label>
            <input
              className="input"
              placeholder="User ID, email, or username — press Enter"
              value={userInput}
              onChange={(event) => setUserInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                const trimmed = userInput.trim();
                setUserFilter(trimmed);
                setPage(0);
                const nextParams = new URLSearchParams(searchParams);
                if (trimmed) {
                  nextParams.set("user", trimmed);
                } else {
                  nextParams.delete("user");
                }
                setSearchParams(nextParams, { replace: true });
              }}
            />
            {userFilter ? (
              <button
                type="button"
                className="mt-2 text-xs text-slate-400 underline-offset-2 hover:underline"
                onClick={() => {
                  setUserInput("");
                  setUserFilter("");
                  setPage(0);
                  const nextParams = new URLSearchParams(searchParams);
                  nextParams.delete("user");
                  setSearchParams(nextParams, { replace: true });
                }}
              >
                Clear filter
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-white/10 pt-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Last seen within</label>
            <div className="flex flex-wrap items-center gap-2">
              {RANGE_PRESETS.map((preset) => {
                const isActive = rangePreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={isActive}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      isActive
                        ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-100"
                        : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:text-white"
                    }`}
                    onClick={() => {
                      setRangePreset(preset.id);
                      setRangeFrom(presetFrom(preset.id));
                      setRangeTo("");
                      setPage(0);
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0">
              <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Custom from</label>
              <input
                className="input"
                type="date"
                value={rangePreset === "custom" ? rangeFrom : ""}
                onChange={(event) => {
                  setRangePreset("custom");
                  setRangeFrom(event.target.value);
                  setRangeTo(rangePreset === "custom" ? rangeTo : "");
                  setPage(0);
                }}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Custom to</label>
              <input
                className="input"
                type="date"
                value={rangePreset === "custom" ? rangeTo : ""}
                onChange={(event) => {
                  setRangeFrom(rangePreset === "custom" ? rangeFrom : "");
                  setRangePreset("custom");
                  setRangeTo(event.target.value);
                  setPage(0);
                }}
              />
            </div>
            {rangePreset === "custom" ? (
              <button
                type="button"
                className="pb-2 text-xs text-slate-400 underline-offset-2 hover:underline"
                onClick={() => {
                  setRangePreset(DEFAULT_RANGE_PRESET);
                  setRangeFrom(presetFrom(DEFAULT_RANGE_PRESET));
                  setRangeTo("");
                  setPage(0);
                }}
              >
                Reset range
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <DataTable
        headers={[
          "Issue",
          "Status",
          "Assigned",
          { label: "Events 7d", align: "right" },
          { label: "Users", align: "right" },
          "Last seen",
        ]}
      >
        {errors.map((error) => (
          <tr
            key={`${error.projectId}-${error.groupId}`}
            className="cursor-pointer text-slate-200 transition hover:bg-white/[0.03]"
            tabIndex={0}
            onClick={() => navigate(`/errors/${error.projectId}/${error.groupId}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(`/errors/${error.projectId}/${error.groupId}`);
              }
            }}
          >
            <td className="max-w-md px-5 py-4 align-top">
              <p className="truncate font-medium text-white" title={error.title}>
                {error.title}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span>{projectNameById.get(error.projectId) ?? error.projectId}</span>
                <span aria-hidden="true" className="text-slate-600">
                  •
                </span>
                <span className="truncate font-mono text-[11px] text-slate-500">{error.fingerprint}</span>
                {error.githubIssueNumber ? (
                  <>
                    <span aria-hidden="true" className="text-slate-600">
                      •
                    </span>
                    <span className="text-cyan-300/80">#{error.githubIssueNumber}</span>
                  </>
                ) : null}
              </p>
            </td>
            <td className="px-5 py-4 align-top">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  label={error.state}
                  tone={STATE_TONES[error.state] ?? "border-white/10 bg-white/5 text-slate-200"}
                />
                <Badge
                  label={error.severity}
                  tone={SEVERITY_TONES[error.severity?.toLowerCase()] ?? "border-white/10 bg-white/5 text-slate-300"}
                />
              </div>
            </td>
            <td className="px-5 py-4 align-top text-sm">
              {error.assignedUserName ? (
                <span className="text-slate-200">{error.assignedUserName}</span>
              ) : (
                <span className="text-slate-500">Unassigned</span>
              )}
            </td>
            <td className="px-5 py-4 align-top text-right">
              <p className="font-medium tabular-nums text-white">{formatNumber(error.count7d)}</p>
              <p className="mt-1 text-xs tabular-nums text-slate-400">{formatNumber(error.count24h)} in 24h</p>
            </td>
            <td className="px-5 py-4 align-top text-right font-medium tabular-nums text-slate-200">
              {formatNumber(error.affectedUsers)}
            </td>
            <td className="px-5 py-4 align-top text-sm">
              <p className="text-slate-200">{formatDate(error.lastSeen)}</p>
              <p className="mt-1 text-xs text-slate-400">First {formatDate(error.firstSeen)}</p>
            </td>
          </tr>
        ))}
      </DataTable>

      <div className="flex items-center justify-between gap-4 text-sm text-slate-300">
        <p>{total === 0 ? "No issues match these filters" : `Showing ${rangeStart}–${rangeEnd} of ${total}`}</p>
        <div className="flex items-center gap-3">
          <button
            className="button-secondary"
            type="button"
            onClick={() => setPage((current) => Math.max(current - 1, 0))}
            disabled={page === 0}
          >
            Previous
          </button>
          <button
            className="button-secondary"
            type="button"
            onClick={() => setPage((current) => current + 1)}
            disabled={(page + 1) * PAGE_SIZE >= total}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
