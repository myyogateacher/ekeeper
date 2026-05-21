# GitHub issue sync

Per-project bridge between eKeeper error groups and GitHub issues. The
intent is that a project owner can wire one eKeeper project to one GitHub
repository and get an issue per error group, with state mirrored in both
directions.

## What it does

- **Outbound auto-create**: the first time an error group is observed in
  a project that has a GitHub integration configured, eKeeper opens a new
  issue in the mapped repo and stores the issue number against the group.
- **Outbound state sync**: closing or reopening an issue in eKeeper
  PATCHes the matching GitHub issue.
- **Inbound state sync**: GitHub posts an Issues webhook to
  `/api/github/webhook`; if the signature checks out, eKeeper updates the
  issue workflow row.
- **Backfill**: a button on Settings creates issues for every existing
  group in the project that isn't already linked.

## Configuration

The Settings page is the primary configuration surface — one form per
project:

- `owner` and `repo` — the target repo (e.g. `myyogateacher`,
  `mobile-myt-new`).
- `defaultLabels` — comma-separated labels applied to every created
  issue.
- `personalAccessToken` — classic GitHub PAT with `repo` scope. For
  SSO-enforced orgs (like myyogateacher), the token must be
  SSO-authorized for the org or every API call returns 404. Stored on
  the integration row in SQLite.
- `webhookSecret` — random string used to HMAC-verify inbound
  webhooks. Must match the secret configured on the GitHub repo
  webhook.

Optional environment fallbacks:

- `GITHUB_TOKEN` — used only if a project hasn't set its own
  `personalAccessToken`. Lets ops keep a single PAT in env for all
  projects if they prefer.
- `GITHUB_API_URL` — defaults to `https://api.github.com`. Only change
  this for GitHub Enterprise.

## How to wire up a new repo end-to-end

1. Create a classic GitHub PAT with the `repo` scope. If your org uses
   SAML SSO, click "Configure SSO" on the token list and authorize for
   the org.
2. Settings → pick the project → fill `owner`, `repo`, labels, paste
   the PAT into "Personal access token", choose any random string for
   "Webhook secret" → Save.
3. In GitHub: repo → Settings → Webhooks → Add webhook:
   - **Payload URL**: `https://<your-ekeeper-host>/api/github/webhook`
   - **Content type**: `application/json`
   - **Secret**: the same string you used in step 2
   - **Events**: only "Issues" (or "Send me everything" if you don't
     mind the noise — only `issues` is handled)
4. Optional: click "Backfill existing issues" on the Settings page to
   open GitHub issues for groups that already exist in eKeeper.

## Code locations

- SQLite schema: `backend/src/migrations/sqlite/007_github_integration.sql`
  (`project_github_integrations`, `error_group_github_issues`)
- GitHub client: `backend/src/lib/github.ts` (POST/PATCH against the
  Issues REST API; no SDK, just `fetch`)
- Sync helpers: `backend/src/lib/issue-sync.ts`
  - `ensureGithubIssueForGroup` — idempotent create-on-first-occurrence
  - `syncGithubIssueState` — outbound state PATCH
  - `findGithubLinkByIssue` — used by the inbound webhook
- Auto-create wiring: `backend/src/lib/ingest-buffer.ts`
  (`maybeCreateGithubIssues`, runs after each flushed bucket)
- HTTP surface: `backend/src/routes/api.ts`
  - `GET/PUT/DELETE /projects/:projectId/github-integration`
  - `POST /projects/:projectId/github-integration/backfill`
  - workflow `PATCH` calls `syncGithubIssueState`
- Webhook: `backend/src/routes/github.ts`
  (`POST /api/github/webhook`, HMAC-SHA256 against `x-hub-signature-256`)
- UI:
  - Settings form + backfill button:
    `frontend/src/pages/SettingsPage.tsx`
  - GitHub badge on detail page:
    `frontend/src/pages/ErrorDetailPage.tsx`
- Contracts: `shared/src/contracts.ts`
  (`ProjectGithubIntegration`, `githubIssueNumber`/`githubIssueUrl` on
  `ErrorGroupSummary` and `ErrorEventDetail`)

## Secret storage

- `personal_access_token` and `webhook_secret` are stored in plaintext
  on the SQLite integration row. The PAT is a real credential; the
  webhook secret is only used for HMAC verification. We accept
  plaintext for now to match the existing posture of `project_keys`,
  but note that this means an attacker with SQLite read access can
  exfiltrate GitHub tokens. Encryption-at-rest is a future improvement.
- The `GET /projects/:projectId/github-integration` response **never
  returns the secret values** — only `personalAccessTokenSet` and
  `webhookSecretSet` booleans. This prevents a project viewer (read
  access) from extracting the PAT via DevTools on the Settings page.
  To replace a secret, type a new value into the form and save; to
  clear, remove the integration entirely.

## Idempotency

- `error_group_github_issues` has `PRIMARY KEY (project_id, group_id)`
  and a `UNIQUE INDEX (project_id, github_issue_number)`. An ingest
  flush that re-sees an existing group will skip the GitHub call —
  `ensureGithubIssueForGroup` short-circuits if the link row exists.
- The webhook handler looks up the integration by `(owner, repo)`, then
  the group link by `(owner, repo, issue_number)`. If either is missing
  the call no-ops; no fake links get written.

## Failure modes and how to read them

- **`GitHub create issue failed (404)`** in the backend log: the PAT
  can't see the repo. Either the repo name is wrong, the PAT doesn't
  have the `repo` scope, or the PAT isn't SSO-authorized for the org.
  Fine-grained PATs return 404 in all of these cases — it's a deliberate
  privacy behaviour, not a missing-repo bug.
- **Webhook returns 401 "Invalid webhook signature"**: either the
  repo isn't mapped to any eKeeper project, the project has no
  `webhookSecret` set, or the secret on the GitHub side doesn't match
  the one in eKeeper. The error is intentionally the same in all three
  cases so the endpoint doesn't leak which repos are mapped.
- **A new error group lands but no GitHub issue appears**: check the
  backend log for an `[issue-sync]` warning. The most likely cause is
  the project having no PAT (neither on the integration row nor in
  `GITHUB_TOKEN`).

## Things this feature deliberately doesn't do

- It doesn't sync issue assignees, labels (beyond create-time defaults),
  comments, or close reasons. Only open/closed state.
- It doesn't retry failed GitHub calls. A transient GitHub 5xx will skip
  one auto-create; the group can be picked up later via Backfill.
- It doesn't handle GitHub rate limits explicitly. Classic PATs get
  5000 req/hour; the backfill loop is sequential so a project with
  more than a few thousand groups would need pacing — not a concern for
  the mobile-myt-new rollout.
