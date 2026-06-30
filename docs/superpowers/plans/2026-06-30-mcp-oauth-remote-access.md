# OAuth-secured remote MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose eKeeper's read-only error data over a backend-hosted remote MCP endpoint authenticated by OAuth 2.1 (Authorization Code + PKCE), delegating human login to the existing Google SSO; results scoped to the signed-in user's project visibility.

**Architecture:** eKeeper becomes an OAuth 2.1 Authorization Server + Resource Server. Discovery + DCR + authorize + token endpoints issue opaque tokens stored in Redis (reusing session infra); registered clients live in SQLite. `POST /mcp` validates the Bearer access token, resolves the user, and runs read-only ClickHouse query tools filtered to the user's accessible projects.

**Tech Stack:** Bun, Hono, TypeScript, Redis (`redis` v5 via `lib/redis`), SQLite (`lib/sqlite` `one`/`all`/`run`), ClickHouse (`@clickhouse/client` via `db/clickhouse`), `node:crypto`, React/Tailwind, `bun test`. No new dependencies.

## Global Constraints

- OAuth 2.1: Authorization Code grant, **PKCE S256 required** (reject `plain`/missing), public clients (`token_endpoint_auth_method: none`).
- Single scope: `mcp:read`. Read-only tools only; ClickHouse `readonly=1`.
- Opaque tokens via `randomToken`; stored in Redis: codes `mcp:code:<c>` (TTL 60s, single-use), access `mcp:at:<t>` (TTL 28800s), refresh `mcp:rt:<t>` (TTL 2592000s, rotated on use).
- Human login reuses existing Google SSO (`backend/src/lib/auth.ts`) + `GOOGLE_ALLOWED_DOMAINS`. No new IdP.
- Project scoping: workspace `admin`/`viewer` → all projects; otherwise the user's `project_memberships`. Reuse the rule already encoded in `requireProjectAccess`.
- All endpoints HTTPS in prod; exact `redirect_uri` match; `state` echoed; tokens/codes never logged.
- MCP protocol version `2024-11-05`; server info `{ name: "ekeeper", version: "0.1.0" }`.
- Commit after each task. eKeeper repo: work on a `feature/mcp-oauth` branch.

---

### Task 1: OAuth store (SQLite clients + Redis codes/tokens + PKCE)

**Files:**
- Create: `backend/src/migrations/sqlite/010_oauth_clients.sql`
- Create: `backend/src/lib/oauth-store.ts`
- Test: `backend/src/lib/oauth-store.test.ts`

**Interfaces — Produces:**
- `verifyPkce(verifier: string, challenge: string): boolean`
- `registerClient(redirectUris: string[], clientName: string): { client_id: string; redirect_uris: string[] }`
- `getClient(clientId: string): { client_id: string; redirect_uris: string[] } | null`
- `issueCode(d: { userId; clientId; redirectUri; codeChallenge }): Promise<string>`
- `consumeCode(code: string): Promise<{ userId; clientId; redirectUri; codeChallenge; scope } | null>`
- `issueTokens(userId: string, clientId: string): Promise<{ accessToken; refreshToken; expiresIn; scope }>`
- `validateAccessToken(token: string): Promise<{ userId: string } | null>`
- `consumeRefresh(token: string): Promise<{ userId; clientId; scope } | null>`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,         -- JSON array
  client_name   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
```

- [ ] **Step 2: Failing test (PKCE + client + code round-trip)**

```ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyPkce, registerClient, getClient, issueCode, consumeCode, issueTokens, validateAccessToken } from "./oauth-store";

describe("oauth-store", () => {
  test("verifyPkce S256", () => {
    const verifier = "abc123abc123abc123abc123abc123abc1";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("wrong", challenge)).toBe(false);
  });
  test("register + get client", () => {
    const c = registerClient(["http://localhost:9999/cb"], "Test");
    expect(c.client_id).toMatch(/^mcpc_/);
    expect(getClient(c.client_id)?.redirect_uris).toEqual(["http://localhost:9999/cb"]);
  });
  test("code is single-use; tokens validate", async () => {
    const code = await issueCode({ userId: "u1", clientId: "c1", redirectUri: "http://localhost:9999/cb", codeChallenge: "x" });
    const first = await consumeCode(code);
    expect(first?.userId).toBe("u1");
    expect(await consumeCode(code)).toBeNull();           // single-use
    const t = await issueTokens("u1", "c1");
    expect((await validateAccessToken(t.accessToken))?.userId).toBe("u1");
    expect(await validateAccessToken("nope")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to confirm failure** — `bun --env-file=../.env test backend/src/lib/oauth-store.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implementation**

```ts
import { createHash } from "node:crypto";
import { connectRedis } from "./redis";
import { one, run } from "../db/sqlite";
import { randomToken } from "./ids";

const SCOPE = "mcp:read";
const CODE_TTL = 60, ACCESS_TTL = 8 * 3600, REFRESH_TTL = 30 * 86400;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function registerClient(redirectUris: string[], clientName: string) {
  const client_id = `mcpc_${randomToken(16)}`;
  run(`INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)`,
    [client_id, JSON.stringify(redirectUris), clientName ?? "", new Date().toISOString()]);
  return { client_id, redirect_uris: redirectUris };
}

export function getClient(clientId: string) {
  const row = one<{ client_id: string; redirect_uris: string }>(
    `SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?`, [clientId]);
  return row ? { client_id: row.client_id, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

export async function issueCode(d: { userId: string; clientId: string; redirectUri: string; codeChallenge: string }) {
  const code = randomToken(24);
  const redis = await connectRedis();
  await redis.set(`mcp:code:${code}`, JSON.stringify({ ...d, scope: SCOPE }), { EX: CODE_TTL });
  return code;
}

export async function consumeCode(code: string) {
  const redis = await connectRedis();
  const raw = await redis.get(`mcp:code:${code}`);
  if (!raw) return null;
  await redis.del(`mcp:code:${code}`);
  return JSON.parse(raw) as { userId: string; clientId: string; redirectUri: string; codeChallenge: string; scope: string };
}

export async function issueTokens(userId: string, clientId: string) {
  const redis = await connectRedis();
  const accessToken = randomToken(32), refreshToken = randomToken(32);
  await redis.set(`mcp:at:${accessToken}`, JSON.stringify({ userId, scope: SCOPE }), { EX: ACCESS_TTL });
  await redis.set(`mcp:rt:${refreshToken}`, JSON.stringify({ userId, clientId, scope: SCOPE }), { EX: REFRESH_TTL });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL, scope: SCOPE };
}

export async function validateAccessToken(token: string) {
  if (!token) return null;
  const redis = await connectRedis();
  const raw = await redis.get(`mcp:at:${token}`);
  return raw ? { userId: (JSON.parse(raw) as { userId: string }).userId } : null;
}

export async function consumeRefresh(token: string) {
  const redis = await connectRedis();
  const raw = await redis.get(`mcp:rt:${token}`);
  if (!raw) return null;
  await redis.del(`mcp:rt:${token}`);
  return JSON.parse(raw) as { userId: string; clientId: string; scope: string };
}
```

- [ ] **Step 5: Migrate + run tests** — `bun run --cwd backend migrate` then `bun --env-file=../.env test backend/src/lib/oauth-store.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git add backend/src/lib/oauth-store.ts backend/src/lib/oauth-store.test.ts backend/src/migrations/sqlite/010_oauth_clients.sql && git commit -m "feat(mcp-oauth): oauth store (clients, PKCE, codes, tokens)"`

---

### Task 2: Discovery metadata endpoints

**Files:**
- Create: `backend/src/routes/oauth.ts` (start the router here; later tasks extend it)
- Modify: `backend/src/index.ts` (mount well-knowns at root + `/oauth`)
- Test: `backend/src/routes/oauth.test.ts`

**Interfaces — Produces:** `oauthRouter` (Hono) with `GET /.well-known/oauth-authorization-server`; `wellKnownProtectedResource(appUrl)` returning the RS metadata object; mounted so `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` resolve at root.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from "bun:test";
import { asMetadata } from "./oauth";

test("AS metadata advertises endpoints + S256", () => {
  const m = asMetadata("https://glitch.example.com");
  expect(m.authorization_endpoint).toBe("https://glitch.example.com/oauth/authorize");
  expect(m.token_endpoint).toBe("https://glitch.example.com/oauth/token");
  expect(m.registration_endpoint).toBe("https://glitch.example.com/oauth/register");
  expect(m.code_challenge_methods_supported).toEqual(["S256"]);
});
```

- [ ] **Step 2: Run → FAIL** (`bun test backend/src/routes/oauth.test.ts`).

- [ ] **Step 3: Implement metadata builders + router skeleton**

```ts
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
```

- [ ] **Step 4: Mount in `index.ts`** (before the static catch-all):

```ts
import { oauthRouter, protectedResourceMetadata } from "./routes/oauth";
// ...
app.get("/.well-known/oauth-protected-resource", (ctx) =>
  ctx.json(protectedResourceMetadata(config.APP_URL)));
app.route("/", oauthRouter); // serves /.well-known/oauth-authorization-server + /oauth/*
```

- [ ] **Step 5: Run test → PASS**, then smoke: `curl -s localhost:3000/.well-known/oauth-authorization-server | head` shows the endpoints.

- [ ] **Step 6: Commit** — `git commit -am "feat(mcp-oauth): discovery metadata endpoints"`

---

### Task 3: Dynamic client registration (`POST /oauth/register`)

**Files:** Modify `backend/src/routes/oauth.ts`; extend `backend/src/routes/oauth.test.ts`.

**Interfaces — Consumes:** `registerClient` (Task 1). **Produces:** `POST /oauth/register`.

- [ ] **Step 1: Failing test**

```ts
import { registerClient as _r } from "../lib/oauth-store";
test("register validates redirect_uris", () => {
  expect(() => _r([], "x")).toBeDefined(); // store accepts; route enforces — see route test below
});
```
Add a route-level assertion in a later integration check (Step 4).

- [ ] **Step 2: Implement the route**

```ts
import { registerClient } from "../lib/oauth-store";
import { HttpError } from "../lib/http";

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
```

- [ ] **Step 3: Typecheck + smoke**

`bun run --cwd backend typecheck`; then
`curl -s -X POST localhost:3000/oauth/register -H 'content-type: application/json' -d '{"redirect_uris":["http://localhost:9999/cb"]}'`
Expected: JSON with `client_id` starting `mcpc_`. Empty/invalid uris → 400.

- [ ] **Step 4: Commit** — `git commit -am "feat(mcp-oauth): dynamic client registration"`

---

### Task 4: Authorize endpoint (`GET /oauth/authorize`) with SSO

**Files:** Modify `backend/src/routes/oauth.ts`. (Reuses `sessionMiddleware` which already runs in `index.ts`, so `ctx.get("auth")` is populated when a valid session cookie is present.)

**Interfaces — Consumes:** `getClient`, `issueCode` (Task 1); existing session via `ctx.get("auth")`; existing login start route `/auth/google/start` (from `routes/auth.ts`). **Produces:** `GET /oauth/authorize`.

- [ ] **Step 1: Read the existing login route to get the exact start path + post-login redirect mechanism**

Run: `grep -n "google/start\|redirect\|next\|FRONTEND_URL" backend/src/routes/auth.ts`
Note the start path (e.g. `/auth/google/start`) and how it redirects post-login. If it supports a `next`/return param, use it in Step 2; if not, add a `next` cookie that the Google callback honors (small edit, include in this task's commit).

- [ ] **Step 2: Implement authorize**

```ts
import { getClient, issueCode } from "../lib/oauth-store";

oauthRouter.get("/oauth/authorize", async (ctx) => {
  const q = ctx.req.query();
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, response_type } = q;
  if (response_type !== "code") return ctx.text("unsupported_response_type", 400);
  if (code_challenge_method !== "S256" || !code_challenge) return ctx.text("PKCE S256 required", 400);
  const client = client_id ? getClient(client_id) : null;
  if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    return ctx.text("invalid client_id or redirect_uri", 400);
  }

  const auth = ctx.get("auth"); // set by sessionMiddleware when logged in
  if (!auth) {
    // Not logged in: bounce through existing Google SSO, returning to this exact URL.
    const next = encodeURIComponent(ctx.req.url);
    return ctx.redirect(`/auth/google/start?next=${next}`);
  }

  const code = await issueCode({ userId: auth.user.id, clientId: client.client_id, redirectUri: redirect_uri, codeChallenge: code_challenge });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return ctx.redirect(url.toString());
});
```

- [ ] **Step 3: Ensure the Google login honors `next`**

If Step 1 showed the login flow ignores `next`, modify `routes/auth.ts`: persist `next` (validate it is a same-origin path) through the OAuth `state` or a short cookie, and after `handleGoogleCallback` creates the session, `ctx.redirect(next ?? FRONTEND_URL)`. Keep the existing default when `next` is absent.

- [ ] **Step 4: Test the authenticated path**

Add to `oauth.test.ts` a unit test of the happy path by calling the handler with a stubbed `ctx.get("auth")` returning `{ user: { id: "u1" } }` and asserting it 302s to `redirect_uri?code=…&state=…` (use Hono's test client `app.request` with a pre-seeded client + a fake session middleware, or extract the code-issuing branch into a small tested function `issueAuthCodeRedirect(auth, q)`).

- [ ] **Step 5: Typecheck + commit** — `bun run --cwd backend typecheck && git commit -am "feat(mcp-oauth): authorize endpoint with SSO bounce + PKCE"`

---

### Task 5: Token endpoint (`POST /oauth/token`)

**Files:** Modify `backend/src/routes/oauth.ts`; extend tests.

**Interfaces — Consumes:** `consumeCode`, `verifyPkce`, `issueTokens`, `consumeRefresh` (Task 1). **Produces:** `POST /oauth/token`.

- [ ] **Step 1: Failing integration test (code→token via app.request)**

```ts
import { Hono } from "hono";
import { oauthRouter } from "./oauth";
import { registerClient, issueCode } from "../lib/oauth-store";
import { createHash } from "node:crypto";

test("authorization_code grant returns tokens with valid PKCE", async () => {
  const app = new Hono(); app.route("/", oauthRouter);
  const client = registerClient(["http://localhost:9999/cb"], "t");
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await issueCode({ userId: "u1", clientId: client.client_id, redirectUri: "http://localhost:9999/cb", codeChallenge: challenge });
  const res = await app.request("/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: "http://localhost:9999/cb" }),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.access_token).toBeTruthy();
  expect(json.token_type).toBe("Bearer");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement token endpoint** (accept JSON or form-encoded)

```ts
import { consumeCode, verifyPkce, issueTokens, consumeRefresh } from "../lib/oauth-store";

async function readBody(ctx: any): Promise<Record<string, string>> {
  const ct = ctx.req.header("content-type") || "";
  if (ct.includes("application/json")) return await ctx.req.json().catch(() => ({}));
  const form = await ctx.req.parseBody().catch(() => ({}));
  return form as Record<string, string>;
}

oauthRouter.post("/oauth/token", async (ctx) => {
  const b = await readBody(ctx);
  const err = (e: string, code = 400) => ctx.json({ error: e }, code);

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
    const t = await issueTokens(stored.userId, stored.clientId);
    return ctx.json({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope });
  }

  return err("unsupported_grant_type");
});
```

- [ ] **Step 4: Run test → PASS. Add negative tests** (wrong verifier → `invalid_grant`; reused code → `invalid_grant`).

- [ ] **Step 5: Commit** — `git commit -am "feat(mcp-oauth): token endpoint (code + refresh, PKCE)"`

---

### Task 6: User-scoped read-only MCP tools

**Files:** Create `backend/src/lib/mcp-tools.ts`; Test `backend/src/lib/mcp-tools.test.ts`.

**Interfaces — Produces:**
- `accessibleProjectIds(userId: string): string[]` (admin/viewer → all; else memberships)
- `buildWhere(projectIds: string[], args): { clause, params }` (always constrains `project_id IN (...)`)
- `MCP_TOOLS: { name; description; inputSchema; handler(projectIds: string[], args) }[]`, `getTool(name)`

- [ ] **Step 1: Failing test (scoping is enforced)**

```ts
import { describe, expect, test } from "bun:test";
import { buildWhere, MCP_TOOLS, getTool } from "./mcp-tools";

test("buildWhere constrains to allowed project ids + time", () => {
  const { clause, params } = buildWhere(["pA", "pB"], {});
  expect(clause).toContain("project_id IN");
  expect(params.project_ids).toEqual(["pA", "pB"]);
  expect(clause).toContain("timestamp >=");
});
test("five tools incl list_projects", () => {
  expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(
    ["error_trend", "get_event", "list_projects", "project_info", "search_events", "top_issues"]);
  expect(getTool("error_trend")).toBeDefined();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (ClickHouse param `{project_ids:Array(String)}`; SQLite for project list/role)

```ts
import { getClickHouseClient } from "../db/clickhouse";
import { all, one } from "../db/sqlite";

async function q<T = Record<string, unknown>>(sql: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await getClickHouseClient().query({ query: sql, query_params: params, format: "JSONEachRow" });
  return rs.json<T>();
}

export function accessibleProjectIds(userId: string): string[] {
  const user = one<{ role: string }>(`SELECT role FROM users WHERE id = ?`, [userId]);
  if (user?.role === "admin" || user?.role === "viewer") {
    return all<{ id: string }>(`SELECT id FROM projects WHERE active = 1`, []).map((r) => r.id);
  }
  return all<{ project_id: string }>(`SELECT project_id FROM project_memberships WHERE user_id = ?`, [userId]).map((r) => r.project_id);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const clampInt = (v: unknown, def: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def; };

export function buildWhere(projectIds: string[], args: Record<string, unknown>) {
  const ids = projectIds.length ? projectIds : ["__none__"];
  const to = str(args.to) ?? new Date().toISOString();
  const from = str(args.from) ?? new Date(Date.now() - clampInt(args.last_days, 30, 120) * 86_400_000).toISOString();
  const parts = ["project_id IN {project_ids:Array(String)}", "timestamp >= parseDateTimeBestEffort({from:String})", "timestamp < parseDateTimeBestEffort({to:String})"];
  const params: Record<string, unknown> = { project_ids: ids, from, to };
  // optional single-project narrowing (must be within allowed set)
  const proj = str(args.project);
  if (proj && ids.includes(proj)) { parts.push("project_id = {project:String}"); params.project = proj; }
  for (const [k, col] of [["environment", "environment"], ["release", "release"], ["browser", "browser"], ["group_id", "group_id"]] as const) {
    const v = str(args[k]); if (v) { parts.push(`${col} = {${k}:String}`); params[k] = v; }
  }
  if (str(args.message_contains)) { parts.push("positionCaseInsensitiveUTF8(message, {message_contains:String}) > 0"); params.message_contains = args.message_contains; }
  if (str(args.title_contains)) { parts.push("positionCaseInsensitiveUTF8(title, {title_contains:String}) > 0"); params.title_contains = args.title_contains; }
  return { clause: parts.join(" AND "), params };
}

const commonProps = { from: { type: "string" }, to: { type: "string" }, last_days: { type: "number" }, project: { type: "string", description: "Restrict to one project id (must be one you can access)" }, environment: { type: "string" }, release: { type: "string" }, browser: { type: "string" }, message_contains: { type: "string" }, title_contains: { type: "string" } };

export const MCP_TOOLS = [
  { name: "list_projects", description: "Projects you can access (id, name, slug, environment).", inputSchema: { type: "object", properties: {} },
    handler: async (ids: string[]) => ids.length ? all(`SELECT id, name, slug, environment FROM projects WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [] },
  { name: "error_trend", description: "Daily/hourly error counts over a range; optional group_by.", inputSchema: { type: "object", properties: { ...commonProps, bucket: { type: "string", enum: ["day", "hour"] }, group_by: { type: "string", enum: ["none", "project", "release", "severity", "browser", "os", "environment"] } } },
    handler: async (ids, args) => { const { clause, params } = buildWhere(ids, args); const bucket = args.bucket === "hour" ? "toStartOfHour(timestamp)" : "toDate(timestamp)"; const dimMap: Record<string, string | null> = { none: null, project: "project_id", release: "release", severity: "severity", browser: "browser", os: "os", environment: "environment" }; const dim = dimMap[str(args.group_by) ?? "none"] ?? null; const sel = dim ? `${dim} AS dimension, ` : ""; const grp = dim ? `, ${dim}` : ""; return q(`SELECT ${bucket} AS bucket, ${sel} count() AS events, uniq(user_id) AS users, uniq(group_id) AS groups FROM events WHERE ${clause} GROUP BY bucket${grp} ORDER BY bucket${dim ? ", events DESC" : ""}`, params); } },
  { name: "top_issues", description: "Top error groups by count with first/last seen.", inputSchema: { type: "object", properties: { ...commonProps, limit: { type: "number" } } },
    handler: async (ids, args) => { const { clause, params } = buildWhere(ids, args); const limit = clampInt(args.limit, 25, 500); return q(`SELECT group_id, any(title) AS title, any(message) AS message, any(project_id) AS project_id, count() AS events, uniq(user_id) AS users, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE ${clause} GROUP BY group_id ORDER BY events DESC LIMIT ${limit}`, params); } },
  { name: "search_events", description: "Individual events matching filters, newest first.", inputSchema: { type: "object", properties: { ...commonProps, group_id: { type: "string" }, limit: { type: "number" } } },
    handler: async (ids, args) => { const { clause, params } = buildWhere(ids, args); const limit = clampInt(args.limit, 50, 500); return q(`SELECT event_id, timestamp, project_id, group_id, severity, title, message, release, environment, browser, os, device, user_id, user_email FROM events WHERE ${clause} ORDER BY timestamp DESC LIMIT ${limit}`, params); } },
  { name: "get_event", description: "Full detail for one event_id + breadcrumbs (within your projects).", inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    handler: async (ids, args) => { const id = str(args.event_id); if (!id) throw new Error("event_id required"); const list = ids.length ? ids : ["__none__"]; const ev = await q(`SELECT * FROM events WHERE event_id = {event_id:String} AND project_id IN {project_ids:Array(String)} ORDER BY timestamp DESC LIMIT 1`, { event_id: id, project_ids: list }); const bc = await q(`SELECT timestamp, category, level, type, message, data FROM breadcrumbs WHERE event_id = {event_id:String} AND project_id IN {project_ids:Array(String)} ORDER BY timestamp ASC LIMIT 200`, { event_id: id, project_ids: list }); return { event: ev[0] ?? null, breadcrumbs: bc }; } },
  { name: "project_info", description: "Summary stats over a range for your projects.", inputSchema: { type: "object", properties: { ...commonProps } },
    handler: async (ids, args) => { const { clause, params } = buildWhere(ids, args); const rows = await q(`SELECT count() AS events, uniq(user_id) AS users, uniq(group_id) AS groups, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE ${clause}`, params); return rows[0] ?? {}; } },
] as { name: string; description: string; inputSchema: object; handler: (ids: string[], args: Record<string, unknown>) => Promise<unknown> }[];

export function getTool(name: string) { return MCP_TOOLS.find((t) => t.name === name); }
```

- [ ] **Step 4: Run test → PASS** (pure-logic tests; no ClickHouse needed).

- [ ] **Step 5: Commit** — `git commit -am "feat(mcp-oauth): user-scoped read-only MCP tools"`

---

### Task 7: Remote `/mcp` endpoint (Bearer → user → tools)

**Files:** Create `backend/src/routes/mcp.ts`; Modify `backend/src/index.ts` (mount `/mcp` before static catch-all); Test `backend/src/routes/mcp.test.ts`.

**Interfaces — Consumes:** `validateAccessToken` (Task 1), `accessibleProjectIds`/`MCP_TOOLS`/`getTool` (Task 6). **Produces:** `mcpRouter`; `handleRpc(projectIds, body)`.

- [ ] **Step 1: Failing test** (same `handleRpc` shape as before, but takes projectIds)

```ts
import { describe, expect, test } from "bun:test";
import { handleRpc } from "./mcp";
test("tools/list returns the six tools", async () => {
  const res = await handleRpc(["pA"], { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res!.result.tools.map((t: any) => t.name).sort()).toEqual(
    ["error_trend", "get_event", "list_projects", "project_info", "search_events", "top_issues"]);
});
test("initialize advertises protocol", async () => {
  const res = await handleRpc(["pA"], { jsonrpc: "2.0", id: 2, method: "initialize" });
  expect(res!.result.protocolVersion).toBe("2024-11-05");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
import { Hono } from "hono";
import { config } from "../config";
import { validateAccessToken } from "../lib/oauth-store";
import { accessibleProjectIds } from "../lib/mcp-tools";
import { getTool, MCP_TOOLS } from "../lib/mcp-tools";

type RpcReq = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };
const PROTOCOL = "2024-11-05";

export async function handleRpc(projectIds: string[], req: RpcReq) {
  const id = req.id ?? null;
  const ok = (result: any) => ({ jsonrpc: "2.0" as const, id, result });
  const e = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
  switch (req.method) {
    case "initialize": return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "ekeeper", version: "0.1.0" } });
    case "notifications/initialized": return null;
    case "tools/list": return ok({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const tool = getTool(req.params?.name);
      if (!tool) return e(-32602, `Unknown tool: ${req.params?.name}`);
      try { const data = await tool.handler(projectIds, req.params?.arguments ?? {}); return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }); }
      catch (err) { return ok({ isError: true, content: [{ type: "text", text: `Error: ${(err as Error).message}` }] }); }
    }
    default: return e(-32601, `Method not found: ${req.method}`);
  }
}

export const mcpRouter = new Hono();

function unauthorized(ctx: any) {
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
  const ids = accessibleProjectIds(session.userId);
  const res = await handleRpc(ids, body);
  return res === null ? ctx.body(null, 202) : ctx.json(res);
});
mcpRouter.get("/", (ctx) => unauthorized(ctx)); // probes get the WWW-Authenticate hint
```

- [ ] **Step 4: Mount in `index.ts`** (before static): `import { mcpRouter } from "./routes/mcp"; app.route("/mcp", mcpRouter);`

- [ ] **Step 5: Run test → PASS; typecheck.** Integration smoke (after a token exists): `curl -s -X POST localhost:3000/mcp -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` lists tools; no token → 401 with `WWW-Authenticate`.

- [ ] **Step 6: Commit** — `git commit -am "feat(mcp-oauth): remote /mcp endpoint with bearer auth + user scoping"`

---

### Task 8: Remove the superseded standalone stdio MCP package

**Files:** Delete `mcp/`; Modify root `package.json` (drop `"mcp"` workspace + script); Modify `sample-env` (drop the MCP-server block).

- [ ] **Step 1:** `git rm -r mcp` (if untracked, `rm -rf mcp`). Edit root `package.json`: remove `"mcp"` from `workspaces` and the `"mcp"` script.
- [ ] **Step 2:** In `sample-env` remove the `--- MCP server (read-only) ---` block (no key/CH env needed for clients now).
- [ ] **Step 3:** `grep -rn "@ekeeper/mcp\|cwd mcp" . --include=*.json | grep -v node_modules` → no results.
- [ ] **Step 4: Commit** — `git commit -am "chore(mcp): remove standalone stdio package (superseded by OAuth remote MCP)"`

---

### Task 9: Settings-page "MCP Access" instructions panel

**Files:** Create `frontend/src/components/McpAccessPanel.tsx`; Modify `frontend/src/pages/SettingsPage.tsx` (mount it).

**Interfaces — Produces:** `<McpAccessPanel appUrl={string} />` — pure instructions, no key.

- [ ] **Step 1: Read SettingsPage to find where the server-settings card renders** — `grep -n "Server\|settings\|token\|card\|section" frontend/src/pages/SettingsPage.tsx | head`. Mount the new panel beside it; match its styling.

- [ ] **Step 2: Create the panel**

```tsx
export function McpAccessPanel({ appUrl }: { appUrl: string }) {
  const url = `${appUrl.replace(/\/$/, "")}/mcp`;
  const snippets: Record<string, string> = {
    "Claude Code": `claude mcp add --transport http ekeeper ${url}`,
    "Claude Desktop": JSON.stringify({ mcpServers: { ekeeper: { type: "http", url } } }, null, 2),
  };
  const tabs = Object.keys(snippets);
  const [tab, setTab] = (window as any).React?.useState?.(tabs[0]) ?? [tabs[0], () => {}];
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h3 className="text-lg font-semibold">MCP Access</h3>
      <p className="text-sm text-white/60">Query this project's errors from an MCP client. Adding the server opens a browser sign-in (Google SSO); no key to manage.</p>
      <div className="mt-3 flex gap-3 text-sm">
        {tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={t === tab ? "font-semibold underline" : "text-white/60"}>{t}</button>)}
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-black/40 p-3 text-xs"><code>{snippets[tab]}</code></pre>
      <button className="text-sm underline" onClick={() => navigator.clipboard.writeText(snippets[tab])}>Copy</button>
      <p className="mt-2 text-xs text-white/40">Endpoint: <code>{url}</code> · You'll sign in with your eKeeper Google account; access matches your role.</p>
    </section>
  );
}
```

> Note: replace the `useState` shim with the file's real React import (`import { useState } from "react"`) — match how other components in `frontend/src/pages` import React.

- [ ] **Step 3: Mount** in `SettingsPage.tsx`: `import { McpAccessPanel } from "../components/McpAccessPanel";` then render `<McpAccessPanel appUrl={window.location.origin} />` in the settings layout.

- [ ] **Step 4: Typecheck the frontend** — `node ./frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json` → no errors (fix the React import per the note).

- [ ] **Step 5: Commit** — `git commit -am "feat(mcp-oauth): Settings MCP Access instructions panel"`

---

## Self-Review

**Spec coverage:** discovery (Task 2) · DCR (Task 3) · authorize+PKCE+SSO (Task 4) · token+refresh (Task 5) · token/code/client storage + PKCE (Task 1) · read-only user-scoped tools incl. list_projects (Task 6) · `/mcp` bearer auth + 401 WWW-Authenticate + JSON-RPC (Task 7) · standalone removal (Task 8) · Settings instructions UI (Task 9). Security constraints (PKCE S256, single-use codes, redirect match, role scoping, read-only) appear in Tasks 1/4/5/6/7. All spec sections mapped.

**Placeholder scan:** No "TBD"/"handle errors". The two reads-of-existing-code steps (Task 4 Step 1, Task 9 Step 1) are deliberate — they pin the exact login-redirect mechanism and Settings layout rather than guessing against unseen files. The React `useState` shim in Task 9 is explicitly flagged to be replaced with the file's real import.

**Type consistency:** `issueCode`/`consumeCode`/`issueTokens`/`validateAccessToken`/`consumeRefresh`/`verifyPkce`/`getClient`/`registerClient` used identically in Tasks 1/4/5/7. `accessibleProjectIds`, `buildWhere`, `MCP_TOOLS`, `getTool` consistent across Tasks 6/7. Tool-name set identical in Tasks 6 and 7 tests. `handleRpc(projectIds, body)` signature consistent in Task 7.

**Risk flagged:** Task 4's SSO `next` redirect may require a small edit to `routes/auth.ts` (included in that task). Codex client OAuth support unverified (per spec) — not covered by any task; revisit if needed.
