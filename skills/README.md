# eKeeper Skills

Working notes about specific eKeeper features. Each file documents one
feature: what it does, where the code lives, how it's configured, and the
common ways it breaks. Read the relevant file before editing that area.

## Features

- [`features/user-filter.md`](features/user-filter.md) — filter the error
  explorer by Sentry user id, email, or username.
- [`features/github-issue-sync.md`](features/github-issue-sync.md) —
  per-project GitHub integration: auto-create issues for new error groups,
  mirror state changes both ways, and backfill existing groups.

## Architecture overview pointers

- Backend architecture: [`docs/backend-architecture.md`](../docs/backend-architecture.md)
- Frontend architecture: [`docs/frontend-architecture.md`](../docs/frontend-architecture.md)
- Development setup: [`docs/development-setup.md`](../docs/development-setup.md)
- Production deployment: [`docs/production-deployment.md`](../docs/production-deployment.md)
