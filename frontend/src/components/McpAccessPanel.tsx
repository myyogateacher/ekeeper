import { useState } from "react";

export function McpAccessPanel({ appUrl }: { appUrl: string }) {
  const url = `${appUrl.replace(/\/$/, "")}/mcp`;
  const snippets: Record<string, string> = {
    "Claude Code": `claude mcp add --transport http ekeeper ${url}`,
    "Claude Desktop": JSON.stringify({ mcpServers: { ekeeper: { type: "http", url } } }, null, 2),
  };
  const tabs = Object.keys(snippets);
  const [tab, setTab] = useState(tabs[0]);

  return (
    <section className="glass-panel p-6">
      <h3 className="text-lg font-semibold text-white">MCP Access</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">
        Query eKeeper errors from an MCP client; adding the server opens a browser sign-in via Google SSO — no key to manage.
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
        onClick={() => void navigator.clipboard.writeText(snippets[tab])}
      >
        Copy
      </button>
      <p className="mt-3 text-xs text-white/40">
        Endpoint: <code>{url}</code> · You'll sign in with your eKeeper Google account; access matches your role.
      </p>
    </section>
  );
}
