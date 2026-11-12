import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "react-toastify";
import { api } from "@/lib/api";
import { copyText } from "@/components/clipboard";
import { SectionHeader } from "./shared";

/** Admin only: the section is hidden from other roles because the upload token is (routes/api.ts:666-682). */
export function ServerSection() {
  const queryClient = useQueryClient();
  const [showToken, setShowToken] = useState(false);
  const { data: settings } = useQuery({ queryKey: ["server-settings"], queryFn: api.serverSettings });
  const { data: token } = useQuery({ queryKey: ["server-upload-token"], queryFn: api.serverUploadToken });
  const regenerate = useMutation({
    mutationFn: api.regenerateServerToken,
    onSuccess: async () => {
      toast.info("Upload token regenerated");
      await queryClient.invalidateQueries({ queryKey: ["server-upload-token"] });
    },
  });
  const values = settings?.settings;

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Server">Read from the server environment. Builds use these to upload source maps.</SectionHeader>
      <section className="card p-4">
        <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] [grid-template-columns:minmax(0,auto)_minmax(0,1fr)]">
          {(
            [
              ["Org", values?.ekeeperOrg],
              ["URL", values?.ekeeperUrl],
              ["Source map retention", values ? `${values.minimapsRetentionDays} days` : undefined],
              ["Releases kept per project", values?.minimapsKeepReleases ? String(values.minimapsKeepReleases) : values ? "no limit" : undefined],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="mono m-0 break-all">{value ?? "Loading"}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="card flex flex-col gap-2.5 p-4">
        <h3 className="m-0 text-sm font-semibold">Upload token</h3>
        <p className="m-0 text-[13px] text-muted">The authToken in the Vite plugin config. Regenerating it breaks every build still using the old one.</p>
        <div className="flex items-center gap-2">
          <input className="input mono flex-1" type={showToken ? "text" : "password"} readOnly value={token?.token ?? ""} aria-label="Upload token" />
          <button
            type="button"
            className="btn btn-icon"
            disabled={!token}
            aria-label={showToken ? "Hide token" : "Show token"}
            onClick={() => setShowToken((value) => !value)}
          >
            {showToken ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            disabled={!token}
            aria-label="Copy token"
            onClick={() => void copyText(token?.token ?? "", "Token copied")}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="btn self-start"
          disabled={regenerate.isPending}
          onClick={() => {
            if (window.confirm("Regenerate the upload token? Builds using the current token fail to upload until updated.")) regenerate.mutate();
          }}
        >
          Regenerate token
        </button>
      </section>
    </div>
  );
}
