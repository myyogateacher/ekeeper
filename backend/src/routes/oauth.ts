import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config";
import { consumeCode, consumeRefresh, findClientByRegistration, getClient, issueCode, issueTokens, registerClient, verifyPkce } from "../lib/oauth-store";
import type { AuthedContext } from "../types/api";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function isAllowedRedirectUri(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:") return LOOPBACK_HOSTS.has(parsed.hostname);
    return false;
  } catch {
    return false;
  }
}

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
  if (uris.length === 0 || !uris.every((u: unknown) => typeof u === "string" && isAllowedRedirectUri(u))) {
    return ctx.json({ error: "redirect_uris must be a non-empty array of https or loopback http URLs" }, 400);
  }
  const clientName = typeof body.client_name === "string" ? body.client_name : "";
  const existing = findClientByRegistration(uris, clientName);
  if (existing) {
    return ctx.json({
      client_id: existing.client_id,
      redirect_uris: existing.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }
  const c = registerClient(uris, clientName);
  ctx.status(201);
  return ctx.json({
    client_id: c.client_id,
    redirect_uris: c.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

oauthRouter.get("/oauth/authorize", async (ctx) => {
  const q = ctx.req.query();
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, response_type } = q;

  // Validate PKCE and response_type before touching client state.
  if (response_type !== "code") return ctx.text("unsupported_response_type", 400);
  if (code_challenge_method !== "S256" || !code_challenge) return ctx.text("PKCE S256 required", 400);

  const client = client_id ? getClient(client_id) : null;
  if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    return ctx.text("invalid client_id or redirect_uri", 400);
  }

  const auth = ctx.get("auth") as AuthedContext | undefined;

  if (!auth) {
    // No active eKeeper session: redirect the user to the SPA login page.
    // The `next` param encodes the full authorize URL so the SPA can redirect back
    // after successful login. This requires the SPA to honor the `next` query param
    // post-login — that wiring is a follow-up; the common case (user already signed
    // into eKeeper in their browser) works end-to-end today.
    return ctx.redirect(`${config.FRONTEND_URL}/?next=${encodeURIComponent(ctx.req.url)}`);
  }

  const code = await issueCode({
    userId: auth.user.id,
    clientId: client.client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
  });

  const dest = new URL(redirect_uri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  return ctx.redirect(dest.toString());
});

async function readBody(ctx: Context): Promise<Record<string, string> | null> {
  const ct = ctx.req.header("content-type") || "";
  try {
    if (ct.includes("application/json")) return await ctx.req.json();
    const form = await ctx.req.parseBody();
    return form as Record<string, string>;
  } catch {
    return null;
  }
}

oauthRouter.post("/oauth/token", async (ctx) => {
  const b = await readBody(ctx);
  const err = (e: string) => ctx.json({ error: e }, 400 as const);

  if (b === null) return err("invalid_request");

  if (b.grant_type === "authorization_code") {
    const stored = await consumeCode(b.code ?? "");
    if (!stored) return err("invalid_grant");
    if (stored.clientId !== b.client_id || stored.redirectUri !== b.redirect_uri) return err("invalid_grant");
    if (!verifyPkce(b.code_verifier ?? "", stored.codeChallenge)) return err("invalid_grant");
    const t = await issueTokens(stored.userId, stored.clientId);
    return ctx.json({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope });
  }

  if (b.grant_type === "refresh_token") {
    const stored = await consumeRefresh(b.refresh_token ?? "");
    if (!stored) return err("invalid_grant");
    if (b.client_id && b.client_id !== stored.clientId) return err("invalid_grant");
    const t = await issueTokens(stored.userId, stored.clientId);
    return ctx.json({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope });
  }

  return err("unsupported_grant_type");
});
