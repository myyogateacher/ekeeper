import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { api } from "@/lib/api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [ghOwner, setGhOwner] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghLabels, setGhLabels] = useState("");
  const [ghWebhookSecret, setGhWebhookSecret] = useState("");
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

  const { data: integrationData } = useQuery({
    queryKey: ["github-integration", selectedProjectId],
    queryFn: () => api.githubIntegration(selectedProjectId),
    enabled: Boolean(selectedProjectId),
  });

  const saveIntegration = useMutation({
    mutationFn: () =>
      api.saveGithubIntegration(selectedProjectId, {
        owner: ghOwner.trim(),
        repo: ghRepo.trim(),
        defaultLabels: ghLabels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        webhookSecret: ghWebhookSecret.trim() ? ghWebhookSecret.trim() : null,
      }),
    onSuccess: async () => {
      toast.info("GitHub integration saved");
      await queryClient.invalidateQueries({ queryKey: ["github-integration", selectedProjectId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to save"),
  });

  const deleteIntegration = useMutation({
    mutationFn: () => api.deleteGithubIntegration(selectedProjectId),
    onSuccess: async () => {
      setGhOwner("");
      setGhRepo("");
      setGhLabels("");
      setGhWebhookSecret("");
      toast.info("GitHub integration removed");
      await queryClient.invalidateQueries({ queryKey: ["github-integration", selectedProjectId] });
    },
  });

  const backfillIntegration = useMutation({
    mutationFn: () => api.backfillGithubIntegration(selectedProjectId),
    onSuccess: (result) => {
      toast.info(
        `Backfill done — created ${result.created} new GitHub issue${result.created === 1 ? "" : "s"}` +
          (result.failed > 0 ? `, ${result.failed} failed` : "") +
          ` (${result.alreadyLinked} already linked).`,
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Backfill failed"),
  });

  useEffect(() => {
    if (!selectedProjectId && projects?.projects?.[0]?.id) {
      setSelectedProjectId(projects.projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const hydratedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!integrationData) {
      return;
    }
    if (hydratedProjectIdRef.current === selectedProjectId) {
      return;
    }
    hydratedProjectIdRef.current = selectedProjectId;
    const integration = integrationData.integration;
    setGhOwner(integration?.owner ?? "");
    setGhRepo(integration?.repo ?? "");
    setGhLabels(integration?.defaultLabels?.join(", ") ?? "");
    setGhWebhookSecret(integration?.webhookSecret ?? "");
  }, [integrationData, selectedProjectId]);

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

      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">GitHub integration</p>
        <h3 className="mt-3 text-2xl font-semibold text-white">Sync issues with GitHub</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
          New error groups in {selectedProject?.name ?? "this project"} will auto-open a GitHub
          issue in the configured repository. Closing or reopening an issue on either side mirrors
          to the other. Configure a webhook on the repo pointing at
          <code className="ml-1 rounded bg-slate-950/40 px-1 py-0.5 text-xs">/api/github/webhook</code>
          (event: Issues) and use the secret below for verification.
        </p>
        <form
          className="mt-5 grid gap-3 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ghOwner.trim() || !ghRepo.trim()) {
              toast.error("Owner and repo are required");
              return;
            }
            saveIntegration.mutate();
          }}
        >
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-400">Owner</label>
            <input
              className="input"
              placeholder="myyogateacher"
              value={ghOwner}
              onChange={(event) => setGhOwner(event.target.value)}
              disabled={!selectedProjectId}
            />
          </div>
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-400">Repo</label>
            <input
              className="input"
              placeholder="mobile-myt-new"
              value={ghRepo}
              onChange={(event) => setGhRepo(event.target.value)}
              disabled={!selectedProjectId}
            />
          </div>
          <div className="lg:col-span-2">
            <label className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-400">
              Default labels (comma separated)
            </label>
            <input
              className="input"
              placeholder="ekeeper, bug"
              value={ghLabels}
              onChange={(event) => setGhLabels(event.target.value)}
              disabled={!selectedProjectId}
            />
          </div>
          <div className="lg:col-span-2">
            <label className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-400">
              Webhook secret
            </label>
            <input
              className="input"
              placeholder="Used to verify incoming GitHub webhooks"
              value={ghWebhookSecret}
              onChange={(event) => setGhWebhookSecret(event.target.value)}
              disabled={!selectedProjectId}
            />
          </div>
          <div className="flex flex-wrap gap-3 lg:col-span-2">
            <button className="button-primary" type="submit" disabled={!selectedProjectId || saveIntegration.isPending}>
              {integrationData?.integration ? "Update integration" : "Save integration"}
            </button>
            {integrationData?.integration ? (
              <>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={backfillIntegration.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Backfill existing error groups to GitHub? One issue will be created per unlinked group in this project.",
                      )
                    ) {
                      backfillIntegration.mutate();
                    }
                  }}
                >
                  {backfillIntegration.isPending ? "Backfilling…" : "Backfill existing issues"}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={deleteIntegration.isPending}
                  onClick={() => {
                    if (window.confirm("Remove this GitHub mapping? Existing issue links will also be deleted.")) {
                      deleteIntegration.mutate();
                    }
                  }}
                >
                  Remove integration
                </button>
              </>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
