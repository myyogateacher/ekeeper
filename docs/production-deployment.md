# Production Deployment

## Deployment Model

eKeeper is designed for a simple production topology:
- Bun backend as the single app server
- ClickHouse for event and analytics storage
- SQLite for relational state and server settings
- built frontend served directly from the backend

## Build

From the repository root:

```bash
bun install
bun run build
```

This produces:
- frontend assets in `frontend/dist/`
- backend bundle in `backend/dist/`

## Required Infrastructure

At minimum, production needs:
- a reachable ClickHouse instance
- persistent storage for SQLite
- persistent storage for uploaded minimaps/source maps

Important filesystem locations:
- SQLite path from `SQLITE_PATH`
- minimap storage path from `MINIMAPS_STORAGE_PATH`

## Required Environment

Review these before starting production:
- `APP_URL`
- `BACKEND_PORT`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `GOOGLE_ALLOWED_DOMAINS`
- `SESSION_SECRET`
- `SQLITE_PATH`
- `CLICKHOUSE_URL`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`
- `CLICKHOUSE_DATABASE`
- `INGEST_DSN_HOST`
- `INGEST_ALLOWED_ORIGINS`
- `EKEEPER_ORG`
- `MINIMAPS_STORAGE_PATH`

Notes:
- `EKEEPER_URL` is derived from `APP_URL`
- the plugin upload token is stored in SQLite and shown in `/settings`

## Start Production Server

From the repository root:

```bash
cd backend && bun --env-file=../.env run ./dist/index.js
```

The backend will:
- run migrations
- initialize persisted server settings
- serve APIs and ingest endpoints
- serve the compiled frontend from `frontend/dist/`

## Docker Compose

For local integration or simple self-hosted deployment:

```bash
docker compose -f docker-compose.sample.yml up --build
```

The included compose file starts:
- `clickhouse`
- `backend`

For teams iterating on the UI, the Vite dev server remains better for local development, but production uses the built SPA only.

## Dockerfile

A production Docker image is included at:
- [Dockerfile](/Users/apple/Desktop/experiments/ekeeper/Dockerfile)

Build it from the repository root:

```bash
docker build -t ekeeper:latest .
```

Run it with your production environment:

```bash
docker run --env-file .env -p 3000:3000 \
  -v $(pwd)/data/sqlite:/app/backend/data/sqlite \
  -v $(pwd)/data/minimaps:/app/backend/data/minimaps \
  ekeeper:latest
```

The image includes:
- compiled backend bundle
- compiled frontend assets
- backend SQL migration files required at startup

## Nginx

An example reverse-proxy config is available at:
- [docs/nginx.conf.md](/Users/apple/Desktop/experiments/ekeeper/docs/nginx.conf.md)

Use Nginx when you want:
- TLS termination in front of Bun
- a stable public hostname for OAuth and DSNs
- larger body-size limits for source map uploads

## Operational Notes

### Migrations

Migrations run on boot. If schema drift or checksum mismatches exist, startup stops rather than serving with an invalid schema.

### Source Maps

Source maps are:
- uploaded through Sentry-compatible artifact routes
- stored on disk
- matched per project slug and release
- used on read when issue detail pages are opened

### Token Rotation

Admins can regenerate the upload token in `/settings`. This invalidates the previous token for all future plugin uploads.

### Auth

Google SSO remains the production login path. The configured callback URL must match the deployed backend URL.
