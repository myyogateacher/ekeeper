import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Copy } from "lucide-react";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/permissions";
import { useMe } from "@/components/session";
import { copyText } from "@/components/clipboard";
import { EmptyState } from "@/components/EmptyState";
import { ProjectPicker, SectionHeader, useSectionProject } from "./shared";

const emptyProject = { name: "", slug: "", environment: "production", active: true };

export function ProjectsSection() {
  const me = useMe();
  const admin = isAdmin(me);
  const queryClient = useQueryClient();
  const section = useSectionProject();
  const [form, setForm] = useState(emptyProject);
  const [formOpen, setFormOpen] = useState(false);

  const createProject = useMutation({
    mutationFn: api.createProject,
    onSuccess: async () => {
      setForm(emptyProject);
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const deleteProject = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Projects"
        action={
          admin ? (
            <button type="button" className="btn btn-primary" aria-expanded={formOpen} onClick={() => setFormOpen((open) => !open)}>
              New project
            </button>
          ) : null
        }
      >
        Each project has its own DSN. Point an SDK at it to start receiving errors.
      </SectionHeader>

      {admin && formOpen ? (
        <form
          className="card grid gap-3 p-4 [grid-template-columns:repeat(3,minmax(0,1fr))_auto] max-[860px]:[grid-template-columns:minmax(0,1fr)]"
          onSubmit={(event) => {
            event.preventDefault();
            createProject.mutate(form);
          }}
        >
          {(
            [
              ["name", "Name", "Web app"],
              ["slug", "Slug", "web-app"],
              ["environment", "Environment", "production"],
            ] as const
          ).map(([key, label, placeholder]) => (
            <label key={key} className="flex flex-col">
              <span className="label">{label}</span>
              <input
                className="input"
                required
                placeholder={placeholder}
                value={form[key]}
                onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <button type="submit" className="btn btn-primary self-end" disabled={createProject.isPending}>
            Create
          </button>
        </form>
      ) : null}

      <section className="card">
        {section.projects.length === 0 && !section.isLoading ? (
          <EmptyState title="No projects yet">{admin ? "Create one with New project." : "Ask an admin to add you to a project."}</EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {section.projects.map((project) => (
              <li key={project.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-[180px] flex-1">
                  <Link to={`/errors?projectId=${encodeURIComponent(project.id)}`} className="font-medium hover:text-accent max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center">
                    {project.name}
                  </Link>
                  <div className="text-xs text-muted">
                    {project.slug} · {project.environment}
                  </div>
                </div>
                <div className="flex min-w-0 max-w-full items-center gap-1.5">
                  <code className="mono min-w-0 truncate text-muted">{project.key?.dsn ?? "Key pending"}</code>
                  {project.key?.dsn ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-icon btn-ghost"
                      aria-label={`Copy DSN for ${project.name}`}
                      onClick={() => void copyText(project.key?.dsn ?? "", "DSN copied")}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
                {admin ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={deleteProject.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${project.name}? Its key stops accepting events.`)) deleteProject.mutate(project.id);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {section.project ? <ConnectApp section={section} admin={admin} /> : null}
    </div>
  );
}

function ConnectApp({ section, admin }: { section: ReturnType<typeof useSectionProject>; admin: boolean }) {
  const { data: settings } = useQuery({ queryKey: ["server-settings"], queryFn: api.serverSettings });
  // The upload token is admin only (routes/api.ts:675); everyone else sees a placeholder in the snippet.
  const { data: token } = useQuery({ queryKey: ["server-upload-token"], queryFn: api.serverUploadToken, enabled: admin });
  const project = section.project!;
  const snippet = settings
    ? `sentryVitePlugin({
  org: "${settings.settings.ekeeperOrg}",
  project: "${project.slug}",
  url: "${settings.settings.ekeeperUrl}",
  authToken: "${token?.token ?? "<upload token, ask an admin>"}",
  reactComponentAnnotation: { enabled: true },
  bundleSizeOptimizations: {
    excludeTracing: true,
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true
  }
})`
    : "Loading";

  return (
    <section className="card flex flex-col gap-4 p-4">
      <SectionHeader title="Connect an app">Three steps to send errors and source maps from a Vite app.</SectionHeader>
      <ProjectPicker section={section} />
      <ol className="m-0 flex list-decimal flex-col gap-3 pl-5 text-[13px]">
        <li>
          Initialise the Sentry SDK with this DSN:{" "}
          <code className="mono break-all text-muted">{project.key?.dsn ?? "key pending"}</code>
        </li>
        <li className="min-w-0">
          Add the Sentry Vite plugin so builds upload source maps here:
          <pre className="mono mt-2 overflow-x-auto rounded-md border border-line bg-code p-3">{snippet}</pre>
          <button type="button" className="btn btn-sm mt-2" disabled={!settings} onClick={() => void copyText(snippet, "Snippet copied")}>
            Copy snippet
          </button>
        </li>
        <li>
          Trigger an error, then check{" "}
          <Link className="text-accent underline underline-offset-4 max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center" to={`/errors?projectId=${encodeURIComponent(project.id)}&range=24h`}>
            {project.name} issues
          </Link>
          . Allow up to ten minutes: ingest writes events in five minute batches and skips the batch still filling.
        </li>
      </ol>
    </section>
  );
}
