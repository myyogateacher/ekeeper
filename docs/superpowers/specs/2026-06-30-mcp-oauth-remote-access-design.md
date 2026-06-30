# Design: OAuth-secured remote MCP for eKeeper

Status: approved direction (2026-06-30). **Supersedes** the shared-key design
(`2026-06-30-project-mcp-access-key-design.md`).

## Goal

Let the team and AI tools (Claude Code, Claude Desktop) query eKeeper's error data
from MCP clients via a **backend-hosted remote MCP endpoint**, authenticated with
**OAuth 2.1 browser login** that reuses eKeeper's existing Google SSO. No shared
secret; per-user identity, audit, and role-based project scoping.

## Decisions

1. **Auth = OAuth 2.1** (Authorization Code + PKCE/S256). eKeeper is both the
   **Authorization Server (AS)** and the **Resource Server (RS)**; the human login
   step is delegated to eKeeper's existing **Google SSO** (domain-enforced).
   **OAuth-only** for v1.
2. **Client support:** Claude Code + Claude Desktop (remote-MCP OAuth) are the
   target. **Codex / headless** OAuth support is uncertain — flagged as a risk to
   verify; a workspace token fallback is a possible later add, **out of scope now**.
3. **Remote MCP** at `POST /mcp` — stateless JSON-RPC, Bearer access-token auth,
   **read-only** tools. Results are scoped to the authenticated user's project
   visibility (workspace `admin`/`viewer` → all projects; `manager`/member → their
   memberships), reusing the existing access model.
4. **Storage:** reuse Redis (already backs sessions) for short-lived auth codes and
   access/refresh tokens; a small SQLite table for dynamically-registered OAuth clients.
5. **Management UI:** Settings-page "MCP Access" panel = **install instructions only**
   (endpoint URL + per-client add command). No key to reveal/rotate. (Optional admin
   "active tokens + revoke" view is **out of scope v1**.)
6. **Supersedes** the standalone stdio `mcp/` package — removed.

## Endpoints

| Endpoint | Spec | Purpose |
|----------|------|---------|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | RS metadata; points clients at the AS |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | AS metadata (authorize/token/register URLs, S256) |
| `POST /oauth/register` | RFC 7591 | Dynamic client registration (DCR) |
| `GET /oauth/authorize` | OAuth 2.1 | PKCE authorize; bounces through Google SSO; issues code |
| `POST /oauth/token` | OAuth 2.1 | code→tokens (PKCE verify) + refresh grant |
| `POST /mcp` (+ `GET` → 401 discovery hint) | MCP | JSON-RPC tools; Bearer access token; 401 → `WWW-Authenticate` |

## Flow

1. MCP client hits `POST /mcp` with no token → **401** + `WWW-Authenticate: Bearer
   resource_metadata="<APP_URL>/.well-known/oauth-protected-resource"`.
2. Client reads protected-resource + AS metadata, does **DCR** (`/oauth/register`) →
   gets a `client_id` (public client; PKCE, no secret).
3. Client opens `/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&
   code_challenge=…&code_challenge_method=S256&state=…&resource=…` in the browser.
   - If no eKeeper session cookie → eKeeper starts its existing **Google SSO**
     (`createGoogleAuthUrl`/callback), stashing the original authorize params; after
     Google returns and the domain is enforced, it resumes the authorize step.
   - With a valid session, eKeeper mints a single-use **auth code** (60 s TTL, bound
     to user + client_id + redirect_uri + code_challenge + scope) in Redis and
     redirects to `redirect_uri?code=…&state=…`.
4. Client calls `POST /oauth/token` (grant_type=authorization_code, `code`,
   `code_verifier`, `client_id`, `redirect_uri`). eKeeper verifies the code +
   **PKCE** (`S256(code_verifier) == code_challenge`) + exact redirect match → issues
   an **opaque access token** (Redis `mcp:at:<token>` → `{userId, scope, exp}`, ~8 h)
   and a **refresh token** (~30 d). Single scope `mcp:read`.
5. Client calls `POST /mcp` with `Authorization: Bearer <access_token>`. eKeeper
   validates the token → loads user + memberships → accessible `project_id`s → runs
   read-only tools filtered to those projects.

## Tools (read-only, user-scoped)

`list_projects`, `error_trend`, `top_issues`, `search_events`, `get_event`,
`project_info` — same ClickHouse queries as the prior design, but every query is
constrained to the **set of project_ids the authenticated user can access**
(admin/viewer → all; otherwise their memberships). Optional `project` arg (id/slug)
must be within that set or it's rejected.

## Token / storage model

- **Auth code:** Redis `mcp:code:<code>` → `{ userId, clientId, redirectUri,
  codeChallenge, scope, exp }`, TTL 60 s, deleted on first use.
- **Access token:** Redis `mcp:at:<token>` → `{ userId, scope, exp }`, TTL ~8 h.
- **Refresh token:** Redis `mcp:rt:<token>` → `{ userId, clientId, scope }`, TTL ~30 d;
  rotated on use.
- **OAuth clients:** SQLite `oauth_clients(client_id PK, redirect_uris TEXT json,
  client_name TEXT, created_at TEXT)`.
- Tokens are opaque random strings (`randomToken`) so revocation = Redis delete
  (reuses the existing session/Redis infra; consistent with how sessions work).

## Security

- PKCE **required** (S256); reject plain.
- Auth codes single-use, 60 s, exact `redirect_uri` match, bound to `client_id`.
- Human auth via existing **Google SSO + allowed-domains** enforcement — no new IdP.
- Access tokens short-lived + refresh; all tokens revocable via Redis.
- HTTPS enforced in prod; `state` echoed; redirect_uris validated at registration and at authorize/token.
- `/mcp` is **read-only**; ClickHouse session runs `readonly=1`; results limited to the user's projects.
- Tokens/codes never logged.

## Out of scope (v1)

- Codex/headless support + any non-browser token path (revisit with a key fallback if needed).
- Active-token admin/revocation UI; consent screen beyond the implicit SSO login.
- Scopes beyond `mcp:read`; write/workflow tools.

## Testing

- Unit: PKCE verify (S256 match/mismatch); code issue→exchange→single-use; token
  issue/validate/expire; DCR redirect_uri validation; user→accessible-projects scoping.
- Integration: full `authorize` (with a stubbed session) → `token` → `POST /mcp`
  `tools/list`/`tools/call`; missing/invalid token → 401 with `WWW-Authenticate`.
- Manual: `claude mcp add --transport http ekeeper <APP_URL>/mcp` → browser login →
  run `error_trend`.

## Open items for the architect

- Confirm OAuth-only (vs. hybrid with a token for Codex/CI).
- Confirm eKeeper's internet exposure (raises bar on token TTLs / HTTPS / rate limits).
- Confirm opaque-Redis tokens (chosen) vs. signed JWTs.
