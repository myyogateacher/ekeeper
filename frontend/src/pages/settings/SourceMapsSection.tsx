import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/permissions";
import { formatAbsolute } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { useMe } from "@/components/session";
import { EmptyState } from "@/components/EmptyState";
import { ProjectPicker, SectionHeader, useSectionProject } from "./shared";

// Values kept from the old source maps page. Cleanup deletes in the background, so the eligible count is
// re-read every 2 s, at most 5 times, until it reaches 0.
const PAGE_SIZE = 25;
const CLEANUP_POLL_INTERVAL_MS = 2000;
const CLEANUP_POLL_ATTEMPTS = 5;

/** Source maps. Listed for admin and viewer (routes/api.ts:696); upload and cleanup are admin only (:707, :740). */
export function SourceMapsSection() {
  const me = useMe();
  const admin = isAdmin(me);
  const queryClient = useQueryClient();
  const section = useSectionProject();
  const projectId = section.project?.id ?? "";
  const [page, setPage] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [upload, setUpload] = useState({ release: "", dist: "", artifactName: "" });
  const [file, setFile] = useState<File | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: settings } = useQuery({ queryKey: ["server-settings"], queryFn: api.serverSettings });
  const { data, isLoading } = useQuery({
    queryKey: ["minimaps", projectId, page],
    queryFn: () => api.minimaps(projectId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
  const artifacts = data?.artifacts ?? [];
  const total = data?.total ?? 0;

  useEffect(() => setPage(0), [projectId]);
  // A cleanup can shrink the total below the current page; step back to the last page that exists.
  useEffect(() => {
    if (total > 0 && page > 0 && page * PAGE_SIZE >= total) setPage(Math.ceil(total / PAGE_SIZE) - 1);
  }, [total, page]);
  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a source map file to upload");
      const formData = new FormData();
      formData.set("release", upload.release);
      formData.set("artifactName", upload.artifactName || file.name);
      formData.set("org", settings?.settings.ekeeperOrg ?? "");
      formData.set("projectId", projectId);
      if (upload.dist) formData.set("dist", upload.dist);
      formData.set("file", file);
      return api.uploadMinimap(formData);
    },
    onSuccess: async () => {
      setUpload({ release: "", dist: "", artifactName: "" });
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["minimaps"] });
    },
  });

  const poll = (attempt: number) => {
    if (attempt > CLEANUP_POLL_ATTEMPTS) return;
    pollRef.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["minimaps"] }).then(() => {
        const remaining = queryClient.getQueryData<{ retentionEligible: number }>(["minimaps", projectId, page])?.retentionEligible;
        if (remaining !== 0) poll(attempt + 1);
      });
    }, CLEANUP_POLL_INTERVAL_MS);
  };
  const cleanup = useMutation({
    mutationFn: () => api.cleanupOldMinimaps(projectId),
    onSuccess: (result) => {
      setCleanupStatus(
        result.started
          ? `Cleanup started. ${formatNumber(result.eligible)} files are being removed in the background.`
          : `A cleanup is already running. ${formatNumber(result.eligible)} files are still eligible.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["minimaps"] });
      if (pollRef.current) clearTimeout(pollRef.current);
      poll(1);
    },
  });

  const retentionDays = settings?.settings.minimapsRetentionDays;
  const keepReleases = settings?.settings.minimapsKeepReleases;
  const policy =
    retentionDays === undefined
      ? "Files outside the retention window"
      : keepReleases && keepReleases > 0
        ? `Files older than ${retentionDays} days, or beyond the ${keepReleases} newest releases,`
        : `Files older than ${retentionDays} days`;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Source maps"
        action={
          admin ? (
            <button type="button" className="btn" aria-expanded={uploadOpen} onClick={() => setUploadOpen((value) => !value)}>
              Upload manually
            </button>
          ) : null
        }
      >
        Builds upload these through the Sentry Vite plugin, so stack frames show your source instead of minified code.
      </SectionHeader>
      <ProjectPicker section={section} />

      {admin && uploadOpen ? (
        <form
          className="card grid gap-3 p-4 [grid-template-columns:repeat(2,minmax(0,1fr))] max-[720px]:[grid-template-columns:minmax(0,1fr)]"
          onSubmit={(event) => {
            event.preventDefault();
            uploadMutation.mutate();
          }}
        >
          <label className="flex flex-col">
            <span className="label">Release</span>
            <input className="input" required value={upload.release} onChange={(event) => setUpload({ ...upload, release: event.target.value })} />
          </label>
          <label className="flex flex-col">
            <span className="label">Dist (optional)</span>
            <input className="input" value={upload.dist} onChange={(event) => setUpload({ ...upload, dist: event.target.value })} />
          </label>
          <label className="flex flex-col [grid-column:1/-1]">
            <span className="label">Artifact path (defaults to the file name)</span>
            <input
              className="input"
              placeholder="~/assets/index.js.map"
              value={upload.artifactName}
              onChange={(event) => setUpload({ ...upload, artifactName: event.target.value })}
            />
          </label>
          <label className="flex flex-col [grid-column:1/-1]">
            <span className="label">File</span>
            <input className="text-[13px]" type="file" accept=".map,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <div className="flex items-center gap-2 [grid-column:1/-1]">
            <button type="submit" className="btn btn-primary" disabled={uploadMutation.isPending}>
              Upload
            </button>
            <span className="text-xs text-muted">
              Plugin project value: <code className="mono">{section.project?.slug ?? "project-slug"}</code>
            </span>
          </div>
        </form>
      ) : null}

      <section className="card">
        <div className="card-head">
          <span className="text-[13px] text-muted">
            {policy} can be removed now: {formatNumber(data?.retentionEligible ?? 0)} in {section.project?.name ?? "this project"}. A daily job
            applies the same rule to every project.
          </span>
          {admin ? (
            <button
              type="button"
              className="btn btn-sm ml-auto"
              disabled={cleanup.isPending || !data?.retentionEligible}
              onClick={() => {
                setCleanupStatus(null);
                if (window.confirm(`Remove ${formatNumber(data?.retentionEligible ?? 0)} old source map files from ${section.project?.name}?`)) {
                  cleanup.mutate();
                }
              }}
            >
              Clean up now
            </button>
          ) : null}
        </div>
        {cleanupStatus ? (
          <p className="m-0 border-b border-line px-4 py-2 text-[13px]" role="status">
            {cleanupStatus}
          </p>
        ) : null}
        {artifacts.length === 0 && !isLoading ? (
          <EmptyState title="No source maps for this project">Add the Sentry Vite plugin from Projects, Connect an app.</EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b border-line px-4 py-2.5 last:border-b-0">
                <div className="min-w-[200px] flex-1">
                  <div className="mono break-all">{artifact.artifactName}</div>
                  <div className="text-xs text-muted">
                    release {artifact.release}
                    {artifact.dist ? `, dist ${artifact.dist}` : ""} · {formatNumber(artifact.size)} bytes
                  </div>
                </div>
                <span className="text-xs text-muted">uploaded {formatAbsolute(artifact.uploadedAt)}</span>
                <span className="text-xs text-muted">expires {formatAbsolute(artifact.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3 text-[13px] text-muted">
          <span>
            {formatNumber(rangeStart)} to {formatNumber(rangeEnd)} of {formatNumber(total)}
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
              Previous
            </button>
            <button type="button" className="btn btn-sm" disabled={rangeEnd >= total} onClick={() => setPage((current) => current + 1)}>
              Next
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
