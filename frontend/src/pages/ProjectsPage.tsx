import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

const emptyProject = { name: "", slug: "", environment: "production", active: true };

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState(emptyProject);
  const { data } = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  const createProject = useMutation({
    mutationFn: api.createProject,
    onSuccess: async () => {
      setForm(emptyProject);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const deleteProject = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Project administration</p>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
          <div>
            <h2 className="text-3xl font-semibold text-white">Projects and ingestion keys</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              Create projects, define environment defaults, and manage the DSN details SDKs use to send errors.
            </p>
          </div>
          <form
            className="grid gap-3 rounded-3xl border border-white/10 bg-slate-950/20 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              createProject.mutate(form);
            }}
          >
            <input
              className="input"
              placeholder="Project name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
            <input
              className="input"
              placeholder="Slug"
              value={form.slug}
              onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
            />
            <input
              className="input"
              placeholder="Environment"
              value={form.environment}
              onChange={(event) => setForm((current) => ({ ...current, environment: event.target.value }))}
            />
            <button className="button-primary" type="submit">
              Add project
            </button>
          </form>
        </div>
      </section>

      <DataTable headers={["Project", "Environment", "DSN", "Actions"]}>
        {(data?.projects ?? []).map((project) => (
          <tr
            key={project.id}
            className="cursor-pointer text-slate-200 transition hover:bg-white/[0.03]"
            tabIndex={0}
            onClick={() => navigate(`/errors?projectId=${encodeURIComponent(project.id)}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(`/errors?projectId=${encodeURIComponent(project.id)}`);
              }
            }}
          >
            <td className="px-5 py-4">
              <div>
                <p className="font-medium text-white">{project.name}</p>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{project.slug}</p>
              </div>
            </td>
            <td className="px-5 py-4">{project.environment}</td>
            <td className="px-5 py-4 text-xs text-slate-300">{project.key?.dsn ?? "Pending key"}</td>
            <td className="px-5 py-4">
              <button
                className="button-secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteProject.mutate(project.id);
                }}
              >
                Remove
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
