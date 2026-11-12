import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";

export function SectionHeader({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {children ? <p className="m-0 mt-1 max-w-2xl text-[13px] text-muted">{children}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * The project a section is scoped to (Source maps, GitHub, Connect an app). Held in `?project=` so a
 * reload or a shared link keeps it, and so switching sections keeps the same project. Falls back to the
 * first project the viewer can see; GET /api/projects already returns only those (routes/api.ts:533-537).
 */
export function useSectionProject() {
  const { data } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [searchParams, setSearchParams] = useSearchParams();
  const projects = data?.projects ?? [];
  const project = projects.find((entry) => entry.id === searchParams.get("project")) ?? projects[0] ?? null;
  const select = (projectId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("project", projectId);
    setSearchParams(next, { replace: true });
  };
  return { projects, project, select, isLoading: !data };
}

export function ProjectPicker({ section }: { section: ReturnType<typeof useSectionProject> }) {
  return (
    <label className="flex max-w-xs flex-col">
      <span className="label">Project</span>
      <select className="input" value={section.project?.id ?? ""} onChange={(event) => section.select(event.target.value)}>
        {section.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
