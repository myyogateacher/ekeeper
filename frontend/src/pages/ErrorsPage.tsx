import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { formatDate, formatNumber } from "@/lib/utils";

export function ErrorsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projectId, setProjectId] = useState(() => searchParams.get("projectId") ?? "");
  const [assignmentFilter, setAssignmentFilter] = useState("any");
  const [state, setState] = useState("open");
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const { data: assignees } = useQuery({
    queryKey: ["error-assignees", projectId || "all"],
    queryFn: () => api.errorAssignees(projectId || undefined),
  });
  const { data } = useQuery({
    queryKey: ["errors", projectId || "all", assignmentFilter, state],
    queryFn: () =>
      api.errors(projectId || undefined, {
        state,
        assignment:
          assignmentFilter === "any" || assignmentFilter === "assigned" || assignmentFilter === "unassigned"
            ? assignmentFilter
            : "user",
        assignedUserId:
          assignmentFilter !== "any" && assignmentFilter !== "assigned" && assignmentFilter !== "unassigned"
            ? assignmentFilter
            : undefined,
      }),
  });

  const projectOptions = useMemo(() => projects?.projects ?? [], [projects]);
  const assigneeOptions = useMemo(() => assignees?.users ?? [], [assignees]);

  useEffect(() => {
    const nextProjectId = searchParams.get("projectId") ?? "";
    if (nextProjectId !== projectId) {
      setProjectId(nextProjectId);
    }
  }, [projectId, searchParams]);

  function handleProjectChange(nextProjectId: string) {
    setProjectId(nextProjectId);
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
        <div className="grid gap-4 lg:grid-cols-3">
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
            <select className="input" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="reopened">Reopened</option>
              <option value="any">Any</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-2 block text-xs uppercase tracking-[0.25em] text-slate-400">Assignment</label>
            <select className="input" value={assignmentFilter} onChange={(event) => setAssignmentFilter(event.target.value)}>
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
        </div>
      </section>

      <DataTable headers={["Issue", "State", "Assigned", "Occurrences", "Severity", "Seen window"]}>
        {(data?.errors ?? []).map((error) => (
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
            <td className="px-5 py-4">
              <div>
                <p className="font-medium text-white">{error.title}</p>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{error.fingerprint}</p>
              </div>
            </td>
            <td className="px-5 py-4">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs capitalize text-slate-200">
                {error.state}
              </span>
            </td>
            <td className="px-5 py-4 text-sm text-slate-300">{error.assignedUserName ?? "Unassigned"}</td>
            <td className="px-5 py-4">{formatNumber(error.count7d)}</td>
            <td className="px-5 py-4 capitalize">{error.severity}</td>
            <td className="px-5 py-4 text-sm text-slate-300">
              <p>{formatDate(error.firstSeen)}</p>
              <p>{formatDate(error.lastSeen)}</p>
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
