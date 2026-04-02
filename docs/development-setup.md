# Development Setup

## Prerequisites

- Bun 1.3+
- Node.js 20+
- Docker / Docker Compose

## Install Dependencies

From the repository root:

```bash
bun install
```

## Environment

The app reads configuration from the root `.env` file.

Important values to review:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `GOOGLE_ALLOWED_DOMAINS`
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
- the server upload token is generated automatically and persisted in SQLite
- the public plugin URL is derived from `APP_URL`
- project slugs are used as the plugin `project` value

## Start Local Infrastructure

Bring up ClickHouse:

```bash
docker compose up -d clickhouse
```

Optional log tail:

```bash
docker compose logs -f clickhouse
```

## Run the Backend

From the repository root:

```bash
bun run dev:backend
```

Behavior:
- runs Bun in watch mode
- loads the root `.env`
- applies SQLite and ClickHouse migrations on boot
- generates the stored plugin upload token if one does not already exist

## Run the Frontend

From the repository root:

```bash
npm run dev:frontend
```

Behavior:
- runs the Vite dev server
- serves the UI on `http://localhost:5173`
- proxies API, auth, and ingest traffic to the backend

## Common Commands

From the repository root:

```bash
bun run dev:backend
npm run dev:frontend
bun run build
bun run typecheck
bun run test
bun run migrate
```

## Daily Workflow

1. Start ClickHouse
2. Start the backend
3. Start the frontend
4. Open `http://localhost:5173`
5. Use `/settings` to copy the current plugin token and project slug when wiring source map uploads

## Troubleshooting

### Backend fails on startup

Usually this means ClickHouse is not reachable. Start it first:

```bash
docker compose up -d clickhouse
```

### Browser ingest fails with CORS

Make sure the frontend origin is allowed by:
- `INGEST_ALLOWED_ORIGINS`

### Sentry Vite plugin upload fails

Check:
- `org` matches `EKEEPER_ORG`
- `project` matches a real eKeeper project slug
- `url` points at the backend base URL
- `authToken` matches the token shown in `/settings`
