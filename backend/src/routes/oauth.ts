import { Hono } from "hono";
import { config } from "../config";
import { registerClient } from "../lib/oauth-store";
import { HttpError } from "../lib/http";

const base = () => config.APP_URL.replace(/\/+$/, "");

export function asMetadata(appUrl: string) {
  const b = appUrl.replace(/\/+$/, "");
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read"],
  };
}

export function protectedResourceMetadata(appUrl: string) {
  const b = appUrl.replace(/\/+$/, "");
  return { resource: `${b}/mcp`, authorization_servers: [b], scopes_supported: ["mcp:read"], bearer_methods_supported: ["header"] };
}

export const oauthRouter = new Hono();
oauthRouter.get("/.well-known/oauth-authorization-server", (ctx) => ctx.json(asMetadata(base())));

oauthRouter.post("/oauth/register", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({}));
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0 || !uris.every((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u))) {
    throw new HttpError(400, "redirect_uris must be a non-empty array of http(s) URLs");
  }
  const c = registerClient(uris, typeof body.client_name === "string" ? body.client_name : "");
  ctx.status(201);
  return ctx.json({
    client_id: c.client_id,
    redirect_uris: c.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});
