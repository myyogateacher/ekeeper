import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "react-toastify";
import { api } from "@/lib/api";

async function copyText(text: string, successMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.info(successMsg);
  } catch {
    toast.error("Couldn't copy to clipboard — copy it manually (clipboard needs a secure/HTTPS context).");
  }
}

export function McpAccessPanel({ appUrl, isAdmin }: { appUrl: string; isAdmin: boolean }) {
  const url = `${appUrl.replace(/\/$/, "")}/mcp`;
  const snippets: Record<string, string> = {
    "Claude Code": `claude mcp add --transport http ekeeper ${url}`,
    "Claude Desktop": JSON.stringify({ mcpServers: { ekeeper: { type: "http", url } } }, null, 2),
  };
  const tabs = Object.keys(snippets);
  const [tab, setTab] = useState(tabs[0]);
  const [showKey, setShowKey] = useState(false);
  const queryClient = useQueryClient();

  const {
    data: keyData,
    isLoading: keyLoading,
    isError: keyError,
    error: keyErr,
  } = useQuery({ queryKey: ["mcp-key"], queryFn: api.mcpKey });
  const mcpKey = keyData?.key ?? "";

  const regenerate = useMutation({
    mutationFn: api.regenerateMcpKey,
    onSuccess: async () => {
      toast.info("MCP secret key rotated");
      await queryClient.invalidateQueries({ queryKey: ["mcp-key"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to rotate key"),
  });

  return (
    <section className="glass-panel p-6">
      <h3 className="text-lg font-semibold text-white">MCP Access</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">
        Query eKeeper errors from an MCP client. Adding the server opens a browser sign-in via Google SSO, or you can
        authenticate with the fixed secret key below — for clients that send a static <code>Authorization</code> header.
      </p>
      <div className="mt-3 flex gap-4 text-sm">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={t === tab ? "font-semibold text-white underline" : "text-white/60 hover:text-white/80"}
          >
            {t}
          </button>
        ))}
      </div>
      <pre className="mt-2 overflow-x-auto rounded-3xl border border-white/10 bg-slate-950/20 p-4 text-xs text-slate-200">
        <code>{snippets[tab]}</code>
      </pre>
      <button
        type="button"
        className="mt-2 text-sm text-slate-300 underline hover:text-white"
        onClick={() => void copyText(snippets[tab], "Copied")}
      >
        Copy
      </button>
      <p className="mt-3 text-xs text-white/40">
        Endpoint: <code>{url}</code> · Signing in with Google scopes access to your role; the secret key below grants
        read access to all projects.
      </p>

      <div className="mt-6 border-t border-white/10 pt-6">
        <h4 className="text-sm font-semibold text-white">Secret key authentication</h4>
        <p className="mt-2 text-xs leading-6 text-slate-400">
          Send this key as <code>Authorization: Bearer &lt;key&gt;</code> to authenticate without the browser sign-in.
          It grants read access to all projects, so treat it like a password.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            className="input flex-1 font-mono"
            type={showKey ? "text" : "password"}
            value={mcpKey}
            readOnly
            placeholder={keyLoading ? "Loading…" : keyError ? "Failed to load key" : ""}
            aria-label="MCP secret key"
          />
          <button
            type="button"
            className="button-secondary shrink-0"
            disabled={!mcpKey}
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? "Hide secret key" : "Show secret key"}
            title={showKey ? "Hide" : "Show"}
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className="button-secondary shrink-0"
            disabled={!mcpKey}
            onClick={() => void copyText(mcpKey, "Secret key copied")}
            aria-label="Copy secret key"
            title="Copy"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        {keyError ? (
          <p className="mt-2 text-xs text-rose-200">
            {keyErr instanceof Error ? keyErr.message : "Failed to load the MCP secret key."}
          </p>
        ) : null}
        {isAdmin ? (
          <button
            type="button"
            className="button-secondary mt-3"
            disabled={regenerate.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Rotate the MCP secret key? Any client using the current key will stop working until updated.",
                )
              ) {
                regenerate.mutate();
              }
            }}
          >
            {regenerate.isPending ? "Rotating…" : "Rotate key"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
