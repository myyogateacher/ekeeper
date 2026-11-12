import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { api } from "@/lib/api";
import { canWriteProject } from "@/lib/permissions";
import { useMe } from "@/components/session";
import { ProjectPicker, SectionHeader, useSectionProject } from "./shared";

const emptyForm = { owner: "", repo: "", labels: "", webhookSecret: "", pat: "" };

/**
 * One GitHub repo per project. Read needs project access, every write needs project write
 * (routes/api.ts:992-1173), so a viewer sees the mapping and a manager membership edits it.
 */
export function GithubSection() {
  const me = useMe();
  const queryClient = useQueryClient();
  const section = useSectionProject();
  const projectId = section.project?.id ?? "";
  const canWrite = projectId !== "" && canWriteProject(me, projectId);
  const [form, setForm] = useState(emptyForm);

  const { data, isLoading } = useQuery({
    queryKey: ["github-integration", projectId],
    queryFn: () => api.githubIntegration(projectId),
    enabled: Boolean(projectId),
  });
  const integration = data?.integration ?? null;

  // Refill the form whenever a different project's mapping arrives. Secrets are never sent back by the
  // server (only *Set flags), so those fields always start empty and blank means "keep the stored one".
  useEffect(() => {
    if (!data) return;
    setForm({
      owner: data.integration?.owner ?? "",
      repo: data.integration?.repo ?? "",
      labels: data.integration?.defaultLabels?.join(", ") ?? "",
      webhookSecret: "",
      pat: "",
    });
  }, [data, projectId]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["github-integration", projectId] });
  const save = useMutation({
    mutationFn: () =>
      api.saveGithubIntegration(projectId, {
        owner: form.owner.trim(),
        repo: form.repo.trim(),
        defaultLabels: form.labels.split(",").map((label) => label.trim()).filter(Boolean),
        webhookSecret: form.webhookSecret.trim() || null,
        personalAccessToken: form.pat.trim() || null,
      }),
    onSuccess: async () => {
      toast.info("GitHub integration saved");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGithubIntegration(projectId),
    onSuccess: async () => {
      toast.info("GitHub integration removed");
      await refresh();
    },
  });
  const backfill = useMutation({
    mutationFn: () => api.backfillGithubIntegration(projectId),
    onSuccess: (result) =>
      toast.info(
        `Backfill done. Created ${result.created} GitHub issue${result.created === 1 ? "" : "s"}` +
          (result.failed > 0 ? `, ${result.failed} failed` : "") +
          `, ${result.alreadyLinked} already linked.`,
      ),
  });
  const cleanup = useMutation({
    mutationFn: () => api.cleanupDuplicateGithubIssues(projectId),
    onSuccess: (result) =>
      toast.info(
        `Cleanup done. Scanned ${result.titlesScanned} titles, closed ${result.duplicatesClosed} duplicates, repaired ${result.linksRepaired} links.`,
      ),
  });

  const { data: settings } = useQuery({ queryKey: ["server-settings"], queryFn: api.serverSettings });
  const webhookUrl = `${(settings?.settings.ekeeperUrl ?? window.location.origin).replace(/\/+$/, "")}/api/github/webhook`;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="GitHub">
        New issues in the project open a GitHub issue in its repo. Closing or reopening on either side mirrors to the other.
      </SectionHeader>
      <ProjectPicker section={section} />

      <form
        className="card grid gap-3 p-4 [grid-template-columns:repeat(2,minmax(0,1fr))] max-[720px]:[grid-template-columns:minmax(0,1fr)]"
        aria-busy={isLoading}
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="m-0 text-[13px] text-muted [grid-column:1/-1]">
          {integration ? `Connected to ${integration.owner}/${integration.repo}.` : "Not connected."}
          {canWrite ? "" : " You can view this mapping; a project manager or admin can change it."}
        </p>
        <fieldset disabled={!canWrite} className="contents">
          <label className="flex flex-col">
            <span className="label">Owner</span>
            <input className="input" required placeholder="myyogateacher" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} />
          </label>
          <label className="flex flex-col">
            <span className="label">Repo</span>
            <input className="input" required placeholder="web-app" value={form.repo} onChange={(event) => setForm({ ...form, repo: event.target.value })} />
          </label>
          <label className="flex flex-col [grid-column:1/-1]">
            <span className="label">Default labels, comma separated</span>
            <input className="input" placeholder="ekeeper, bug" value={form.labels} onChange={(event) => setForm({ ...form, labels: event.target.value })} />
          </label>
          <label className="flex flex-col">
            <span className="label">Personal access token</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={integration?.personalAccessTokenSet ? "Set. Leave blank to keep it" : "Classic token with repo scope"}
              value={form.pat}
              onChange={(event) => setForm({ ...form, pat: event.target.value })}
            />
          </label>
          <label className="flex flex-col">
            <span className="label">Webhook secret</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={integration?.webhookSecretSet ? "Set. Leave blank to keep it" : "openssl rand -hex 32"}
              value={form.webhookSecret}
              onChange={(event) => setForm({ ...form, webhookSecret: event.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2 [grid-column:1/-1]">
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {integration ? "Update" : "Connect"}
            </button>
            {integration ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={backfill.isPending}
                  onClick={() => {
                    if (window.confirm("Open a GitHub issue for every issue in this project that has none?")) backfill.mutate();
                  }}
                >
                  Backfill existing issues
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={cleanup.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Close duplicate GitHub issues opened by eKeeper? The oldest per fingerprint is kept; the rest are commented and closed as not planned.",
                      )
                    ) {
                      cleanup.mutate();
                    }
                  }}
                >
                  Close duplicate GitHub issues
                </button>
                <button
                  type="button"
                  className="btn ml-auto"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Disconnect this repo? Existing issue links are deleted too.")) remove.mutate();
                  }}
                >
                  Disconnect
                </button>
              </>
            ) : null}
          </div>
        </fieldset>
      </form>

      <details className="card p-4 text-[13px]">
        <summary className="cursor-pointer font-semibold">How to set up the token and webhook</summary>
        <ol className="m-0 mt-3 flex list-decimal flex-col gap-2 pl-5">
          <li>
            GitHub, your avatar, Settings, Developer settings, Personal access tokens, Tokens (classic), Generate new token. Tick the{" "}
            <code className="mono">repo</code> scope and copy the token.
          </li>
          <li>If the org enforces SSO, choose Configure SSO next to the token and authorise it for the org. Without this every call returns 404.</li>
          <li>
            Generate a secret with <code className="mono">openssl rand -hex 32</code> and paste it in Webhook secret above.
          </li>
          <li>
            On the repo: Settings, Webhooks, Add webhook. Payload URL <code className="mono break-all">{webhookUrl}</code>, content type{" "}
            <code className="mono">application/json</code>, the same secret, and only the Issues event.
          </li>
        </ol>
      </details>
    </div>
  );
}
