# Frontend Architecture

## Overview

The frontend is a Vite + React + TypeScript + Tailwind application focused on error operations workflows: dashboards, issue triage, project administration, user administration, source map management, and server settings.

Core entrypoints:
- [frontend/src/main.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/main.tsx)
- [frontend/src/App.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/App.tsx)

## Design Direction

The UI uses a glass-like enterprise SaaS style:
- translucent panels
- soft borders
- backdrop blur
- dense but readable data views
- emphasis on tables, detail panes, and operational workflows

The visual shell is implemented in:
- [frontend/src/components/AppShell.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/components/AppShell.tsx)

## Routing Model

The app uses React Router with:
- a protected app layout
- a public login route
- nested product routes

Primary routes:
- `/login`
- `/dashboard`
- `/projects`
- `/users`
- `/errors`
- `/errors/:projectId/:groupId`
- `/minimaps`
- `/settings`

Routing is defined in:
- [frontend/src/App.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/App.tsx)

## Data Fetching

The frontend uses TanStack Query for:
- session bootstrap
- server state caching
- mutation lifecycle handling
- invalidation after writes

The API client lives in:
- [frontend/src/lib/api.ts](/Users/apple/Desktop/experiments/ekeeper/frontend/src/lib/api.ts)

This file centralizes:
- authenticated JSON requests
- form upload requests for minimaps
- project, user, error, workflow, and settings endpoints

## Shell and Navigation

The app shell provides:
- collapsible sidebar navigation
- responsive desktop/mobile layout
- session-aware logout
- admin-only navigation entries for minimaps and settings

Implemented in:
- [frontend/src/components/AppShell.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/components/AppShell.tsx)

## Major Screens

### Dashboard

- top-level project health cards
- recurring issue visibility
- quick monitoring summary

File:
- [frontend/src/pages/DashboardPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/DashboardPage.tsx)

### Projects

- create and remove projects
- view DSNs and project metadata

File:
- [frontend/src/pages/ProjectsPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/ProjectsPage.tsx)

### Users

- add, edit, remove users
- manage workspace roles
- manage project access

File:
- [frontend/src/pages/UsersPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/UsersPage.tsx)

### Errors

- issue list filtering
- workflow visibility
- assignment filtering
- project-scoped drill-down entry

File:
- [frontend/src/pages/ErrorsPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/ErrorsPage.tsx)

### Error Detail

- workflow actions
- assignment controls
- deobfuscated stack traces when source maps exist
- breadcrumbs, request data, tags, user, extra payload, contexts
- raw event download

File:
- [frontend/src/pages/ErrorDetailPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/ErrorDetailPage.tsx)

### Minimaps

- project-scoped source map uploads
- artifact listing
- manual cleanup for artifacts older than 30 days

File:
- [frontend/src/pages/MinimapsPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/MinimapsPage.tsx)

### Settings

- plugin-facing org/url/token values
- selected project slug for plugin configuration
- token regeneration
- copy-ready Vite snippet

File:
- [frontend/src/pages/SettingsPage.tsx](/Users/apple/Desktop/experiments/ekeeper/frontend/src/pages/SettingsPage.tsx)

## Shared Contracts

The frontend consumes shared application types from:
- [shared/src/contracts.ts](/Users/apple/Desktop/experiments/ekeeper/shared/src/contracts.ts)

This keeps frontend and backend aligned for:
- users
- projects
- issue summaries
- issue detail payloads
- minimap artifacts
- server settings

## Build and Delivery

Development:
- Vite runs the dev server directly
- API, auth, and ingest traffic are proxied to the backend

Production:
- Vite builds the SPA into `frontend/dist/`
- the Bun backend serves the built assets

This keeps development fast while still allowing a single-server production deployment.
