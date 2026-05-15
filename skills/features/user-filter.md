# User filter on the Errors page

Lets a viewer search the error explorer for all groups touched by a
specific Sentry user — by `id`, `email`, or `username`. Useful when a
student reports a problem and we want to see every group their device hit.

## How it works

1. Sentry SDKs pass a `user` object on each event (`user.id`,
   `user.email`, `user.username`). The mobile app sets these in
   `Sentry.setUser({...})`.
2. The ingest normalizer (`backend/src/lib/ingest.ts`) maps each field
   onto a separate column on the ClickHouse `events` row:
   `user_id`, `user_email`, `user_username`.
3. The errors list endpoints accept `?user=<value>` and apply a
   `HAVING countIf(user_id = :v OR user_email = :v OR user_username = :v) > 0`
   on the grouped result — i.e. the group is returned if at least one
   event in the group matches that user identity in any of the three
   fields.
4. The frontend renders an extra input next to Project / State /
   Assignment that submits the query as `?user=…` and writes the value
   into the URL so the filter is shareable.

## Code locations

- ClickHouse schema: `backend/src/migrations/clickhouse/002_user_identity.sql`
- Ingest mapping: `backend/src/lib/ingest.ts` (`normalizeEvent`)
- Buffer insert: `backend/src/lib/ingest-buffer.ts` (`insertEvents`)
- Query + filter: `backend/src/routes/api.ts` (`queryErrorGroups`,
  `apiRouter.get("/projects/all/errors")`, `/projects/:projectId/errors`)
- UI: `frontend/src/pages/ErrorsPage.tsx`
- API client: `frontend/src/lib/api.ts` (`api.errors`)
- Contract: `shared/src/contracts.ts` (`NormalizedIngestEvent`)

## Operational notes

- The match is exact across all three fields, single-term. We're not doing
  prefix or fuzzy matching — keep it simple, the lookup is keyed off
  primary identifiers that come straight from the SDK.
- Older events ingested before migration 002 only have `user_id`
  populated. The filter still works against those, but searching by email
  or username will only hit them if email/username also happens to be in
  `user_id`.
- The previous `userId` fallback was "id, else email" — we kept the
  separation because filtering needs each field on its own column.

## How to extend

- To add another searchable identity field (e.g. `ip_address`), add the
  column in a new ClickHouse migration, populate it from
  `normalizeEvent`, and include it in the `HAVING` clause.
- The current input is a single text box. If you need typeahead from
  recent users, add a backend endpoint that does
  `SELECT DISTINCT user_email FROM events WHERE project_id = …` with a
  `LIMIT` and feed it into the existing input.
