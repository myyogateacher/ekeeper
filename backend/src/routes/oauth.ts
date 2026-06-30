import { Hono } from "hono";
import { config } from "../config";

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
