import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "react-toastify";
import { api } from "@/lib/api";
import { isAdmin } from "@/lib/permissions";
import { useMe } from "@/components/session";
import { copyText } from "@/components/clipboard";
import { SectionHeader } from "./shared";

/** MCP access. The key is readable by every signed-in role, rotation is admin only (routes/api.ts:685-693). */
export function McpSection() {
  const me = useMe();
  const queryClient = useQueryClient();
  const url = `${window.location.origin}/mcp`;
  const snippets = {
    "Claude Code": `claude mcp add --transport http ekeeper ${url}`,
    "Claude Desktop": JSON.stringify({ mcpServers: { ekeeper: { type: "http", url } } }, null, 2),
  };
  const [tab, setTab] = useState<keyof typeof snippets>("Claude Code");
  const [showKey, setShowKey] = useState(false);
  const { data, isLoading, isError } = useQuery({ queryKey: ["mcp-key"], queryFn: api.mcpKey });
  const key = data?.key ?? "";

  const rotate = useMutation({
    mutationFn: api.regenerateMcpKey,
    onSuccess: async () => {
      toast.info("MCP key rotated");
      await queryClient.invalidateQueries({ queryKey: ["mcp-key"] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="MCP access">
        Query eKeeper issues from an MCP client. Adding the server opens a Google sign-in scoped to your role.
      </SectionHeader>

      <section className="card">
        <div className="card-head" role="tablist" aria-label="MCP client">
          {(Object.keys(snippets) as Array<keyof typeof snippets>).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              className={`btn btn-sm ${name === tab ? "" : "btn-ghost"}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void copyText(snippets[tab], "Copied")}>
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
          </button>
        </div>
        <pre className="mono m-0 overflow-x-auto bg-code p-4" role="tabpanel">
          {snippets[tab]}
        </pre>
      </section>

      <section className="card flex flex-col gap-2.5 p-4">
        <h3 className="m-0 text-sm font-semibold">Workspace key</h3>
        <p className="m-0 text-[13px] text-muted">
          For clients that send a fixed header: <code className="mono">Authorization: Bearer &lt;key&gt;</code>. One workspace key with read access
          to all projects, so treat it like a password.
        </p>
        <div className="flex items-center gap-2">
          <input
            className="input mono flex-1"
            type={showKey ? "text" : "password"}
            readOnly
            value={key}
            placeholder={isLoading ? "Loading" : isError ? "Couldn't load the key" : ""}
            aria-label="MCP workspace key"
          />
          <button
            type="button"
            className="btn btn-icon"
            disabled={!key}
            aria-label={showKey ? "Hide key" : "Show key"}
            onClick={() => setShowKey((value) => !value)}
          >
            {showKey ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
          <button type="button" className="btn btn-icon" disabled={!key} aria-label="Copy key" onClick={() => void copyText(key, "Key copied")}>
            <Copy className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {isAdmin(me) ? (
          <button
            type="button"
            className="btn self-start"
            disabled={rotate.isPending}
            onClick={() => {
              if (window.confirm("Rotate the MCP key? Clients using the current key stop working until updated.")) rotate.mutate();
            }}
          >
            Rotate key
          </button>
        ) : null}
      </section>
    </div>
  );
}
