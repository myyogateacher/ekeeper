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

Two places:

1. **Server env** (`.env`):
   - `GITHUB_TOKEN` — classic PAT with `repo` scope. For SSO-enforced
     orgs (like myyogateacher), the token must be SSO-authorized for
     the org or every API call returns 404.
   - `GITHUB_API_URL` — defaults to `https://api.github.com`. Only change
     this for GitHub Enterprise.
2. **Per-project**, via the Settings page → "GitHub integration" section:
   - `owner` and `repo` — the target repo (e.g. `myyogateacher`,
     `mobile-myt-new`).
   - `defaultLabels` — comma-separated labels applied to every created
     issue.
   - `webhookSecret` — random string used to HMAC-verify inbound
     webhooks. Must match the secret you configure on the GitHub repo
     webhook.

## How to wire up a new repo end-to-end

1. Create or pick a classic PAT with `repo`, SSO-authorize for the org,
   put it in `.env` as `GITHUB_TOKEN`, restart the backend.
2. Settings → pick the project → fill `owner`, `repo`, labels, webhook
   secret → Save.
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
  `GITHUB_TOKEN` not set in env. The integration is configured per
  project but the token is global — both have to be present.

## Things this feature deliberately doesn't do

- It doesn't sync issue assignees, labels (beyond create-time defaults),
  comments, or close reasons. Only open/closed state.
- It doesn't retry failed GitHub calls. A transient GitHub 5xx will skip
  one auto-create; the group can be picked up later via Backfill.
- It doesn't handle GitHub rate limits explicitly. Classic PATs get
  5000 req/hour; the backfill loop is sequential so a project with
  more than a few thousand groups would need pacing — not a concern for
  the mobile-myt-new rollout.
