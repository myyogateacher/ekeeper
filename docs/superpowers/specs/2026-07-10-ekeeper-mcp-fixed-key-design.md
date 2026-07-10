# eKeeper MCP — fixed secret key authentication

Date: 2026-07-10
Status: Approved (design)
Builds on: `feature/mcp-oauth` (OAuth 2.1 remote MCP)

## Problem

The eKeeper MCP endpoint (`POST /mcp`) currently authenticates only via OAuth
2.1 with PKCE — adding the server triggers a browser sign-in via Google SSO and
issues a short-lived, user-scoped bearer access token. Some MCP clients cannot
run the interactive OAuth dance (headless setups, clients that only support a
static `Authorization` header). We want an alternative: authenticate with a
single fixed secret key.

## Decisions

- **Scope:** one global secret key granting read access to **all active
  projects** (equivalent to an admin/viewer scope). Not per-user.
- **Storage:** auto-generated on first read, stored in the existing
  `server_settings` SQLite key/value table (key `ekeeper_mcp_secret_key`),
  regeneratable. Mirrors the existing `ekeeper_auth_token` upload-token pattern.
- **Visibility:** the key is viewable/copyable by **every signed-in user** on
  the Settings page. **Rotation** is restricted to **admins**.
- **Transport:** client sends `Authorization: Bearer <key>`. Same endpoint as
  OAuth — OAuth validation is tried first, then the fixed-key fallback.

## Architecture

Auth resolution in `POST /mcp` (resolved before the body is parsed):

1. Extract the bearer token.
2. If it has the `mcpk_` prefix, treat it as a fixed secret key: constant-time
   compare against the stored key (SQLite only — **no Redis dependency**, so
   headless key clients keep working through an OAuth/Redis blip). Match →
   `allActiveProjectIds()` (all active projects); mismatch → `401`. No OAuth
   access token uses that prefix (they are 64-char hex), so there is no
   crossover.
3. Otherwise, `validateAccessToken(token)` (OAuth path). Session →
   `accessibleProjectIds(session.userId)` (unchanged, user-scoped); no session →
   `401`.
4. `401` responses carry the existing `WWW-Authenticate` resource-metadata hint.

Only the project-id resolution differs between the two auth methods; `handleRpc`
and the tools are unchanged.

> Prefix-routing (rather than "OAuth-first, key-fallback") came out of code
> review: it keeps the fixed-key path independent of Redis, which is the whole
> point of offering it to headless clients.

## Changes

### Backend

- `lib/server-settings.ts` — add `getMcpSecretKey()` (get-or-create) and
  `regenerateMcpSecretKey()`. Key format `mcpk_<48 hex>`. Factor the shared
  upsert/read of `server_settings` into small private helpers used by both the
  upload token and the MCP key (removes existing duplication). The MCP key is
  **not** added to `getServerSettings()` (that response is admin/viewer-gated;
  the key must be visible to everyone).
- `lib/mcp-tools.ts` — extract `allActiveProjectIds()` (the query
  `accessibleProjectIds` already runs for admin/viewer) and reuse it there.
- `routes/mcp.ts` — add the fixed-key fallback using `crypto.timingSafeEqual`
  (length-guarded). Reorder so auth is resolved before the request body is
  parsed.
- `routes/api.ts` — two endpoints:
  - `GET /api/settings/mcp-key` → `requireAuth` (any signed-in user) → `{ key }`
  - `POST /api/settings/mcp-key/regenerate` → `requireWorkspaceRole(["admin"])`
    → `{ key }`

### Frontend

- `lib/api.ts` — `mcpKey()` (GET) and `regenerateMcpKey()` (POST).
- `components/McpAccessPanel.tsx` — new "Secret key authentication" subsection
  below the endpoint line: a read-only input masked by default (`type` toggles
  password↔text), an eye button to reveal, a copy button, and an admin-only
  "Rotate key" button (confirm dialog → mutation → refetch). Fetched with
  react-query; takes a new `isAdmin` prop. Update the panel copy to mention both
  auth options.
- `pages/SettingsPage.tsx` — pass `isAdmin` into `McpAccessPanel`.

No shared-contract change: the endpoints return an inline `{ key: string }`.
No DB migration: `server_settings` already exists (migration `005`).

## Security tradeoff (accepted)

The key grants all-projects read access and is visible to every signed-in user,
including managers who would otherwise see only their own projects' errors in the
UI. Any signed-in user can therefore reach all projects' error data via MCP using
this key. Rotation is admin-only, so a leaked key can only be rotated by an
admin. This is the deliberate consequence of "global scope + visible to
everyone" and is accepted for this internal, SSO-gated tool.

## Testing

- `routes/mcp.test.ts` — valid secret key → `200`, `tools/list` returns the six
  tools; wrong key → `401`. (Existing OAuth and no-auth cases stay green.)
- `lib/server-settings.test.ts` — `getMcpSecretKey()` is stable and matches
  `mcpk_<48 hex>`; `regenerateMcpSecretKey()` changes the stored value.
- `bun test` + `typecheck` green.
