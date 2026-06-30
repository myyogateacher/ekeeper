import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config";
import { validateAccessToken } from "../lib/oauth-store";
import { accessibleProjectIds, getTool, MCP_TOOLS } from "../lib/mcp-tools";
import { HttpError } from "../lib/http";

type RpcReq = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };
const PROTOCOL = "2024-11-05";

export async function handleRpc(projectIds: string[], req: RpcReq) {
  const id = req.id ?? null;
  const ok = (result: any) => ({ jsonrpc: "2.0" as const, id, result });
  const e = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
  switch (req.method) {
    case "initialize":
      return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "ekeeper", version: "0.1.0" } });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return ok({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const tool = getTool(req.params?.name);
      if (!tool) return e(-32602, `Unknown tool: ${req.params?.name}`);
      try {
        const data = await tool.handler(projectIds, req.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        return ok({ isError: true, content: [{ type: "text", text: `Error: ${(err as Error).message}` }] });
      }
    }
    default:
      return e(-32601, `Method not found: ${req.method}`);
  }
}

export const mcpRouter = new Hono();

function unauthorized(ctx: Context) {
  const meta = `${config.APP_URL.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
  ctx.header("WWW-Authenticate", `Bearer resource_metadata="${meta}"`);
  return ctx.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
}

mcpRouter.post("/", async (ctx) => {
  const authz = ctx.req.header("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  const session = await validateAccessToken(token);
  if (!session) return unauthorized(ctx);
  const body = await ctx.req.json().catch(() => null);
  if (!body) return ctx.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  let ids: string[];
  try { ids = accessibleProjectIds(session.userId); }
  catch (e) { if (e instanceof HttpError && e.status === 401) return unauthorized(ctx); throw e; }
  const res = await handleRpc(ids, body);
  return res === null ? ctx.body(null, 202) : ctx.json(res);
});

mcpRouter.get("/", (ctx) => unauthorized(ctx));
