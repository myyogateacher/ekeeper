# Backend Architecture

## Overview

The backend is a Bun + Hono application responsible for authentication, project and user administration, Sentry-compatible ingest, issue workflow state, source map uploads, and production delivery of the compiled frontend.

Core entrypoint:
- [backend/src/index.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/index.ts)

## Runtime Responsibilities

The backend owns:
- Google SSO session creation and cookie-based auth
- workspace and project authorization
- REST APIs for users, projects, errors, dashboard summaries, minimaps, and server settings
- Sentry-style ingest endpoints for SDK error delivery
- Sentry-style artifact upload endpoints for source map uploads
- SQLite and ClickHouse migrations on boot
- static serving of `frontend/dist/` in production

## Data Storage Split

### SQLite

SQLite stores relational and configuration data:
- users
- sessions
- projects
- project keys / DSNs
- project memberships
- issue workflow state
- server settings
- minimap artifact metadata

Relevant files:
- [backend/src/db/sqlite.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/db/sqlite.ts)
- [backend/src/migrations/sqlite/001_initial.sql](/Users/apple/Desktop/experiments/ekeeper/backend/src/migrations/sqlite/001_initial.sql)
- [backend/src/migrations/sqlite/003_issue_workflows.sql](/Users/apple/Desktop/experiments/ekeeper/backend/src/migrations/sqlite/003_issue_workflows.sql)
- [backend/src/migrations/sqlite/004_minimap_artifacts.sql](/Users/apple/Desktop/experiments/ekeeper/backend/src/migrations/sqlite/004_minimap_artifacts.sql)
- [backend/src/migrations/sqlite/005_server_settings_and_minimap_projects.sql](/Users/apple/Desktop/experiments/ekeeper/backend/src/migrations/sqlite/005_server_settings_and_minimap_projects.sql)

### ClickHouse

ClickHouse stores high-volume event and breadcrumb data:
- normalized error events
- breadcrumb records
- dashboard and issue-list query source data

Relevant files:
- [backend/src/db/clickhouse.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/db/clickhouse.ts)
- [backend/src/migrations/clickhouse/001_initial.sql](/Users/apple/Desktop/experiments/ekeeper/backend/src/migrations/clickhouse/001_initial.sql)

## Request Flow

### Auth

Google OAuth is handled in:
- [backend/src/routes/auth.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/routes/auth.ts)
- [backend/src/lib/auth.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/lib/auth.ts)

Flow:
1. frontend requests `/auth/google/start`
2. backend redirects to Google
3. callback exchanges the code for an ID token
4. allowed Google domains are enforced
5. a session row is created in SQLite
6. a signed cookie is returned to the browser

### App APIs

Primary application APIs live in:
- [backend/src/routes/api.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/routes/api.ts)

These routes cover:
- `GET /api/me`
- user and project administration
- dashboard summaries
- issue listing and issue detail
- workflow updates
- minimap management
- server settings

### Ingest

Sentry-compatible event ingest lives in:
- [backend/src/routes/ingest.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/routes/ingest.ts)
- [backend/src/lib/ingest.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/lib/ingest.ts)

The backend accepts:
- store payloads
- envelope payloads

Normalization converts incoming events into:
- a stable group id
- a normalized event title/message
- tags, contexts, breadcrumbs, runtime metadata
- raw payload preservation for drill-down views

### Source Map Uploads

Sentry-style artifact upload support lives in:
- [backend/src/routes/plugin.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/routes/plugin.ts)
- [backend/src/lib/minimaps.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/lib/minimaps.ts)
- [backend/src/lib/server-settings.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/lib/server-settings.ts)

Important behavior:
- `EKEEPER_ORG` stays environment-backed
- upload token is generated and stored in SQLite
- `EKEEPER_URL` is derived from `APP_URL`
- each eKeeper project uses its own project slug for plugin uploads
- source maps are stored on disk while metadata stays in SQLite

## Error Detail Deobfuscation

Deobfuscation happens on read, not on ingest.

When issue detail is requested:
1. the backend loads the latest raw event from ClickHouse
2. it reads the event release from the stored payload
3. it finds uploaded source maps for the matching eKeeper project and release
4. it rewrites stack frames to original source positions where mappings exist
5. it returns the enriched event while preserving the raw payload

This keeps ingest fast and makes source map uploads retroactively useful for older events.

## Migration Strategy

Boot-time migrations are coordinated from:
- [backend/src/lib/migrations.ts](/Users/apple/Desktop/experiments/ekeeper/backend/src/lib/migrations.ts)

Behavior:
- SQLite migrations are tracked in `schema_migrations`
- ClickHouse migrations are tracked in its own `schema_migrations` table
- the backend refuses to continue on checksum mismatch
- app startup runs migrations before serving traffic

## Internal Modules

### `lib/auth.ts`
- session loading
- role enforcement
- Google callback handling

### `lib/minimaps.ts`
- source map storage
- artifact listing
- retention cleanup
- release/path matching
- frame deobfuscation

### `lib/server-settings.ts`
- persisted server token generation
- token regeneration
- derivation of public plugin-facing settings

### `routes/api.ts`
- main product API layer

### `routes/ingest.ts`
- SDK ingest compatibility layer

### `routes/plugin.ts`
- Sentry Vite plugin compatibility layer for source map uploads

## Production Shape

In production, the backend is the single public server:
- APIs and auth endpoints are served by Hono
- ingest endpoints are served by Hono
- the built SPA is served from `frontend/dist/`

This keeps deployment simple and avoids needing a separate frontend server once the app is built.
