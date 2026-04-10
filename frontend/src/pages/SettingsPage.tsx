import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { data } = useQuery({
    queryKey: ["server-settings"],
    queryFn: api.serverSettings,
  });
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  });
  const regenerateToken = useMutation({
    mutationFn: api.regenerateServerToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["server-settings"] });
    },
  });

  useEffect(() => {
    if (!selectedProjectId && projects?.projects?.[0]?.id) {
      setSelectedProjectId(projects.projects[0].id);
    }
  }, [projects, selectedProjectId]);

  if (isLoading) {
    return <section className="glass-panel p-6 text-slate-300">Loading server settings...</section>;
  }

  const isAdmin = me?.user.role === "admin";
  const settings = data?.settings;
  const selectedProject = projects?.projects.find((project) => project.id === selectedProjectId) ?? projects?.projects[0];
  const viteSnippet = settings
    ? `sentryVitePlugin({
  org: "${settings.ekeeperOrg}",
  project: "${selectedProject?.slug ?? ""}",
  url: "${settings.ekeeperUrl}",
  authToken: "${settings.ekeeperAuthToken}",
  reactComponentAnnotation: { enabled: true },
  bundleSizeOptimizations: {
    excludeTracing: true,
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true
  }
})`
    : "Loading plugin configuration...";

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Server settings</p>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
          <div>
            <h2 className="text-3xl font-semibold text-white">Plugin-ready server configuration</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              These values are read from the server environment and can be copied directly into your Vite build config.
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-5 text-sm text-slate-300">
            <p className="font-medium text-white">Sentry Vite plugin compatibility</p>
            <p className="mt-2 leading-6">
              eKeeper accepts source map uploads through Sentry-style artifact endpoints, so you only need to point
              the plugin at this server and token.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">EKEEPER_PROJECT</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Each project uses its own slug here, so source maps and uploads stay scoped to the matching eKeeper project.
          </p>
          <select
            className="input mt-3"
            value={selectedProject?.id ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            {(projects?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Token lifecycle</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Regenerating the upload token invalidates the previous token for all future plugin uploads.
          </p>
          {isAdmin ? (
            <button
              className="button-secondary mt-4"
              type="button"
              onClick={() => {
                if (window.confirm("Regenerate the upload token? Existing plugin uploads will stop working until updated.")) {
                  regenerateToken.mutate();
                }
              }}
              disabled={regenerateToken.isPending}
            >
              Regenerate token
            </button>
          ) : null}
        </div>
      </section>

      <section className="glass-panel p-6">
        <h3 className="text-lg font-semibold text-white">Vite snippet</h3>
        <pre className="mt-4 overflow-x-auto rounded-3xl border border-white/10 bg-slate-950/20 p-4 text-xs text-slate-200">
{viteSnippet}
        </pre>
      </section>
    </div>
  );
}
