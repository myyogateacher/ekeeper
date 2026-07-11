import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config";
import { validateAccessToken } from "../lib/oauth-store";
import { accessibleProjectIds, allActiveProjectIds, getTool, MCP_TOOLS } from "../lib/mcp-tools";
import { getMcpSecretKey } from "../lib/server-settings";
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

// Constant-time comparison of the presented bearer token against the fixed MCP
// secret key. Length-guarded because timingSafeEqual throws on unequal lengths.
function matchesMcpSecretKey(token: string): boolean {
  if (!token) return false;
  const presented = Buffer.from(token);
  const secret = Buffer.from(getMcpSecretKey());
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

mcpRouter.post("/", async (ctx) => {
  const authz = ctx.req.header("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";

  // Resolve auth before parsing the body. The `mcpk_` prefix marks a fixed
  // secret key: validate it against SQLite only (no Redis dependency, since
  // headless key clients must keep working through an OAuth/Redis blip). No
  // OAuth access token uses that prefix. Everything else is an OAuth token.
  let ids: string[];
  if (token.startsWith("mcpk_")) {
    if (!matchesMcpSecretKey(token)) return unauthorized(ctx);
    ids = allActiveProjectIds();
  } else {
    const session = await validateAccessToken(token);
    if (!session) return unauthorized(ctx);
    try { ids = accessibleProjectIds(session.userId); }
    catch (e) { if (e instanceof HttpError && e.status === 401) return unauthorized(ctx); throw e; }
  }

  const body = await ctx.req.json().catch(() => null);
  if (!body) return ctx.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const res = await handleRpc(ids, body);
  return res === null ? ctx.body(null, 202) : ctx.json(res);
});

mcpRouter.get("/", (ctx) => unauthorized(ctx));
