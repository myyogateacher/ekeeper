import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

const PAGE_SIZE = 25;
const CLEANUP_POLL_INTERVAL_MS = 2000;
const CLEANUP_POLL_ATTEMPTS = 5;

export function MinimapsPage() {
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [release, setRelease] = useState("");
  const [dist, setDist] = useState("");
  const [artifactName, setArtifactName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [page, setPage] = useState(0);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const cleanupPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  });
  const { data } = useQuery({
    queryKey: ["minimaps", selectedProjectId, page],
    queryFn: () =>
      api.minimaps(selectedProjectId || undefined, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: Boolean(selectedProjectId),
    placeholderData: keepPreviousData,
  });
  const { data: settings } = useQuery({
    queryKey: ["server-settings"],
    queryFn: api.serverSettings,
  });

  const artifacts = data?.artifacts ?? [];
  const total = data?.total ?? 0;
  // Server settings are admin/viewer only (the payload carries an upload token), so
  // roles without access get generic copy rather than a wrong hardcoded number.
  const retentionDays = settings?.settings.minimapsRetentionDays;
  const keepReleases = settings?.settings.minimapsKeepReleases;
  const retentionPolicy =
    retentionDays === undefined
      ? "Artifacts outside the configured retention window"
      : keepReleases && keepReleases > 0
        ? `Artifacts older than ${retentionDays} days, or beyond the ${keepReleases} most recent releases per project,`
        : `Artifacts older than ${retentionDays} days`;
  const cleanupLabel =
    retentionDays === undefined
      ? "Remove minimaps outside retention"
      : keepReleases && keepReleases > 0
        ? `Remove minimaps outside the ${retentionDays}-day / ${keepReleases}-release window`
        : `Remove minimaps older than ${retentionDays} days`;

  useEffect(() => {
    if (!selectedProjectId && projects?.projects?.[0]?.id) {
      setSelectedProjectId(projects.projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // Snap back to the last valid page when the total shrinks (for example after a cleanup).
  useEffect(() => {
    if (total > 0 && page > 0 && page * PAGE_SIZE >= total) {
      setPage(Math.ceil(total / PAGE_SIZE) - 1);
    }
  }, [total, page]);

  useEffect(() => () => {
    if (cleanupPollRef.current) {
      clearTimeout(cleanupPollRef.current);
    }
  }, []);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) {
        throw new Error("Choose a source map file to upload");
      }

      const formData = new FormData();
      formData.set("release", release);
      formData.set("artifactName", artifactName || file.name);
      formData.set("org", settings?.settings.ekeeperOrg ?? "");
      formData.set("projectId", selectedProjectId);
      if (dist) {
        formData.set("dist", dist);
      }
      formData.set("file", file);
      return api.uploadMinimap(formData);
    },
    onSuccess: async () => {
      setRelease("");
      setDist("");
      setArtifactName("");
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["minimaps"] });
    },
  });

  // Deletion runs in the background, so poll a few times until the eligible count settles.
  const pollCleanupProgress = (attempt: number) => {
    if (attempt > CLEANUP_POLL_ATTEMPTS) {
      return;
    }

    cleanupPollRef.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["minimaps"] }).then(() => {
        const remaining = queryClient.getQueryData<{ retentionEligible: number }>([
          "minimaps",
          selectedProjectId,
          page,
        ])?.retentionEligible;
        if (remaining === 0) {
          return;
        }
        pollCleanupProgress(attempt + 1);
      });
    }, CLEANUP_POLL_INTERVAL_MS);
  };

  const cleanupMutation = useMutation({
    mutationFn: api.cleanupOldMinimaps,
    onSuccess: (result) => {
      setCleanupStatus(
        result.started
          ? `Cleanup started — ${result.eligible} artifacts will be removed in the background.`
          : `A cleanup is already running — ${result.eligible} artifacts still eligible.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["minimaps"] });
      if (cleanupPollRef.current) {
        clearTimeout(cleanupPollRef.current);
      }
      pollCleanupProgress(1);
    },
  });

  if (isLoading) {
    return <section className="glass-panel p-6 text-slate-300">Loading minimaps...</section>;
  }

  const isAdmin = me?.user.role === "admin";

  const selectedProject = projects?.projects.find((project) => project.id === selectedProjectId) ?? projects?.projects[0];

  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const rangeStart = total === 0 ? 0 : Math.min(page * PAGE_SIZE + 1, rangeEnd);

  return (
    <div className="space-y-6">
      <section className="glass-panel p-6">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Minimaps</p>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div>
            <h2 className="text-3xl font-semibold text-white">Source maps and deobfuscation</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              Upload your generated source maps so eKeeper can translate minified stack frames back into source code
              when engineers inspect errors.
            </p>
            <label className="mt-5 block max-w-sm text-sm text-slate-300">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Project</span>
              <select
                className="input pr-10"
                value={selectedProject?.id ?? ""}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setPage(0);
                }}
              >
                {(projects?.projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/20 p-5 text-sm text-slate-300">
            <p className="font-medium text-white">Retention</p>
            <p className="mt-2 leading-6">
              {retentionPolicy} can be removed in one action, and a scheduled cleanup applies the same policy daily.
              This applies across all projects, not just the one selected above. Right now{" "}
              {data?.retentionEligible ?? 0} uploaded minimaps are eligible.
            </p>
            {isAdmin ? (
              <>
                <button
                  className="button-secondary mt-4"
                  type="button"
                  onClick={() => {
                    setCleanupStatus(null);
                    cleanupMutation.mutate();
                  }}
                  disabled={cleanupMutation.isPending}
                >
                  {cleanupLabel}
                </button>
                {cleanupStatus ? <p className="mt-3 text-sm text-cyan-100">{cleanupStatus}</p> : null}
                {cleanupMutation.error ? (
                  <p className="mt-3 text-sm text-rose-200">{cleanupMutation.error.message}</p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </section>

      {isAdmin ? (
        <section className="glass-panel p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Upload a minimap</h3>
              <p className="mt-1 text-sm text-slate-300">
                Manual uploads are useful for testing or backfilling a release.
              </p>
            </div>
            <button
              className="button-secondary"
              type="button"
              onClick={() => setIsUploadOpen((open) => !open)}
            >
              {isUploadOpen ? "Hide upload form" : "Show upload form"}
            </button>
          </div>
          {isUploadOpen ? (
            <form
              className="mt-4 grid gap-3 lg:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                uploadMutation.mutate();
              }}
            >
              <input
                className="input"
                placeholder="Release"
                value={release}
                onChange={(event) => setRelease(event.target.value)}
              />
              <input
                className="input"
                placeholder="Dist (optional)"
                value={dist}
                onChange={(event) => setDist(event.target.value)}
              />
              <input
                className="input lg:col-span-2"
                placeholder="Artifact path, for example ~/assets/index.js.map"
                value={artifactName}
                onChange={(event) => setArtifactName(event.target.value)}
              />
              <input
                className="input lg:col-span-2 file:mr-4 file:rounded-2xl file:border-0 file:bg-cyan-300/20 file:px-4 file:py-2 file:text-sm file:text-cyan-100"
                type="file"
                accept=".map,application/json"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <div className="lg:col-span-2 flex items-center gap-3">
                <button className="button-primary" type="submit" disabled={uploadMutation.isPending}>
                  Upload minimap
                </button>
                {uploadMutation.error ? <p className="text-sm text-rose-200">{uploadMutation.error.message}</p> : null}
              </div>
              <p className="lg:col-span-2 text-sm text-slate-300">
                Plugin project value for this upload: <span className="font-mono text-cyan-100">{selectedProject?.slug ?? "<project-slug>"}</span>
              </p>
            </form>
          ) : null}
        </section>
      ) : null}

      <DataTable headers={["Artifact", "Release", "Org / Project", "Uploaded", "Expires"]}>
        {artifacts.map((artifact) => (
          <tr key={artifact.id} className="text-slate-200">
            <td className="px-5 py-4">
              <div>
                <p className="break-all font-medium text-white">{artifact.artifactName}</p>
                <p className="mt-1 text-xs text-slate-400">{artifact.size.toLocaleString()} bytes</p>
              </div>
            </td>
            <td className="px-5 py-4">
              <div>
                <p>{artifact.release}</p>
                <p className="text-xs text-slate-400">{artifact.dist ?? "No dist"}</p>
              </div>
            </td>
            <td className="px-5 py-4 text-sm text-slate-300">
              {artifact.org} / {artifact.project}
            </td>
            <td className="px-5 py-4 text-sm text-slate-300">{formatDate(artifact.uploadedAt)}</td>
            <td className="px-5 py-4 text-sm text-slate-300">{formatDate(artifact.expiresAt)}</td>
          </tr>
        ))}
      </DataTable>

      <div className="flex items-center justify-between gap-4 text-sm text-slate-300">
        <p>
          {total === 0 ? "No minimaps uploaded" : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
        </p>
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
            disabled={rangeEnd >= total}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
