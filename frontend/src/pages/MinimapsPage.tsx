import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

export function MinimapsPage() {
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [release, setRelease] = useState("");
  const [dist, setDist] = useState("");
  const [artifactName, setArtifactName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  });
  const { data } = useQuery({
    queryKey: ["minimaps", selectedProjectId],
    queryFn: () => api.minimaps(selectedProjectId || undefined),
    enabled: Boolean(selectedProjectId),
  });
  const { data: settings } = useQuery({
    queryKey: ["server-settings"],
    queryFn: api.serverSettings,
  });

  useEffect(() => {
    if (!selectedProjectId && projects?.projects?.[0]?.id) {
      setSelectedProjectId(projects.projects[0].id);
    }
  }, [projects, selectedProjectId]);

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

  const cleanupMutation = useMutation({
    mutationFn: api.cleanupOldMinimaps,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["minimaps"] });
    },
  });

  if (isLoading) {
    return <section className="glass-panel p-6 text-slate-300">Loading minimaps...</section>;
  }

  const isAdmin = me?.user.role === "admin";

  const selectedProject = projects?.projects.find((project) => project.id === selectedProjectId) ?? projects?.projects[0];

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
                onChange={(event) => setSelectedProjectId(event.target.value)}
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
              Artifacts older than 30 days can be removed in one action. Right now {data?.olderThanThirtyDays ?? 0}{" "}
              uploaded minimaps are eligible.
            </p>
            {isAdmin ? (
              <button
                className="button-secondary mt-4"
                type="button"
                onClick={() => cleanupMutation.mutate()}
                disabled={cleanupMutation.isPending}
              >
                Remove minimaps older than 30 days
              </button>
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
        {(data?.artifacts ?? []).map((artifact) => (
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
    </div>
  );
}
