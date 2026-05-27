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

## Issue body shape

`buildIssueBody` (in `issue-sync.ts`) renders the body so downstream
automations — especially the Claude auto-fix workflow on
`mobile-myt-new` — have enough context to locate the failing call site
without re-reading the eKeeper UI:

```
**Project:** student-app-prod
**Fingerprint:** `abc123...`
**First seen:** 2026-05-23T23:32:54Z
**Release:** `com.myyogateacher.studentapp@4.0.3+1`
**Exception type:** `TypeError`

Reported automatically by eKeeper.

**Message:**
```
Cannot read properties of undefined (reading 'target')
```

**Stack (top 8, source-mapped):**
```
at handleEvent (src/features/session/hooks/useSession.ts:88:12)
at apiCall (src/features/session/services/api.ts:142:18)
...
```

View in eKeeper: https://glitch.azure-services.../errors/<projectId>/<groupId>
```

Source-mapped frames come from `deobfuscateEvent` in `minimaps.ts`. If
the project has matching source maps uploaded for that release, frames
point at `src/...` paths in the original codebase. If maps aren't
available, the body falls back to the minified frames and the heading
says `(top 8, minified)` so the consumer knows.

The fingerprint marker line is what `cleanupDuplicateGithubIssues`
parses when bucketing — see "Cleaning up existing duplicates" below.

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

Three layers, cheapest first:

1. **Local link row** — `error_group_github_issues` has
   `PRIMARY KEY (project_id, group_id)` and a
   `UNIQUE INDEX (project_id, github_issue_number)`. If a link exists
   for the group, `ensureGithubIssueForGroup` short-circuits with no
   GitHub call.
2. **GitHub-side label search** — when the local link is missing, the
   backend searches the repo for an issue tagged with
   `ek:fp:<fingerprint>` (the fingerprint label). If any match comes
   back, the oldest one is claimed in the local link table and reused.
   This is what survives a SQLite wipe or `DELETE` of the integration
   row.
3. **POST a new issue** with the `ek:fp:<fingerprint>` label as the
   final step, only if both prior checks come up empty.

Removing the integration via `DELETE /github-integration` no longer
cascades to `error_group_github_issues`; link rows persist so a
reconfigure picks up where it left off.

The webhook handler looks up the integration by `(owner, repo)`, then
the group link by `(owner, repo, issue_number)`. If either is missing
the call no-ops; no fake links get written.

## Cleaning up existing duplicates

`POST /projects/:projectId/github-integration/cleanup-duplicates`
(invoked from the Settings page "Clean up duplicate GitHub issues"
button) does a one-shot reconcile against the live repo:

1. List every issue in the repo (paginated, 100 per page).
2. For each issue, parse the eKeeper fingerprint from the
   `**Fingerprint:** \`<hash>\`` line we always include in the body.
   Issues without that marker are skipped (not ours).
3. **Group by exact issue title.** Same title = same logical error,
   even if the eKeeper fingerprints differ (which they do across
   releases — see "Fingerprint stability" below).
4. For each title with one or more eKeeper issues:
   - Pick the oldest issue as canonical.
   - Collect every fingerprint that appears in the bucket. Add an
     `ek:fp:<fingerprint>` label to the canonical for every one of
     them. So if four releases produced four split groups, the
     canonical ends up with four labels, and future ingest events
     matching any of those fingerprints will hit the
     `listGithubIssuesByLabel` check and reuse the canonical.
   - Repoint every fingerprint's local link row at the canonical
     issue. Multiple eKeeper groups can now legitimately share a
     GitHub issue — that's the desired behaviour for split-by-release
     groups.
   - Comment "Duplicate of #N" on every other issue in the bucket
     and close them with `state_reason: not_planned`.

Idempotent — running it twice produces zero further changes.

## Fingerprint stability across releases

`computeGroupFingerprint` hashes `type | normalizedValue | last-4-frames`:

- Each frame is `filename:function`. Line and column numbers are
  **deliberately excluded** — they shift with every JS bundle rebuild
  and would otherwise produce a fresh group for the same bug after
  every release.
- The exception value passes through `normalizeExceptionValue` first:
  hex pointer addresses (`0x[0-9a-fA-F]{4,}`) collapse to `0x_`, and
  inside any `{key=value, ...}` block (Apple's `NSDictionary`
  description style) the comma-separated pairs are sorted
  alphabetically. Innermost braces are processed first via a
  fixed-point loop; nested braces are tracked with a top-level-comma
  splitter so a `{a, b, {c, d}}` block stays grouped correctly.

The same normalized form is used as the issue title in
`normalizeEvent`, so the title cleanup buckets stay aligned with the
fingerprint. The raw payload on the detail page is untouched —
debugging info is preserved.

Why this matters: an iOS `NSError` printed as
`UserInfo={NSUnderlyingError=0x303ae6bb0 {Code=28}, NSURL=...}` and
`UserInfo={NSURL=..., NSUnderlyingError=0x303a575d0 {Code=28}}` are
the same logical error but used to produce two groups and two GitHub
issues. After normalization, they share a fingerprint and a title.

Events that landed *before* this change retain their historical
fingerprints in `events`. The cleanup tool merges them on the GitHub
side; eKeeper's own grouping stays split for old data. New events
ingested after the change are stable.

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
- Cleanup paginates through every issue in the repo and is heavier than
  the dedup-on-create path. For a repo with tens of thousands of issues
  the loop will need pacing or a search-API rewrite.
