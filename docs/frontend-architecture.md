# Frontend Architecture

Vite, React 19, TypeScript, Tailwind 3.4, React Router 7, TanStack Query 5. The backend serves the built
SPA from `frontend/dist/` with a fallback to `index.html`, so a new client route needs no backend change.

Entry points: `frontend/src/main.tsx` (query client, toasts), `frontend/src/App.tsx` (routes).

## Where code goes

| Kind | Location | Rule |
|---|---|---|
| Decision logic: filters, sorting, permissions, time, URL state | `frontend/src/lib/*.ts` | Pure, no React, no fetch. Every rule has a test in `*.test.ts` beside it. |
| API calls | `frontend/src/lib/api.ts` | One `request()`; failures throw `ApiError` with the HTTP status. |
| Shared UI and hooks | `frontend/src/components/` | Read lib helpers, never re-implement them. |
| Screens | `frontend/src/pages/`, Settings sections in `pages/settings/` | Read the URL, call hooks, render. |

**Canonical page: `pages/ErrorsPage.tsx`.** Copy its shape for a new page: state in the URL, logic in
`lib/`, the signed-in user from `useMe()`, writes through a shared mutation hook.

## Routes

| Path | Screen |
|---|---|
| `/login` | Google sign-in |
| `/errors` | Issues list, the home page. Filters, search, sort and range live in the query string. |
| `/errors/:projectId/:groupId` | Issue detail. `?event=<eventId>` selects an event. GitHub issue bodies link here, so the path is fixed. |
| `/settings/:section` | `projects`, `members`, `source-maps`, `github`, `mcp`, `server` |
| `/`, `/dashboard`, unknown | Redirect to `/errors`. The backend lands every sign-in on `/dashboard`, which restores the page the user was sent away from. |
| `/projects`, `/users`, `/minimaps`, `/settings` | Redirect to their Settings section. |

## Theme and styles

- Colours are CSS variables in `frontend/src/theme/tokens.css`, the only file allowed to hold a colour
  literal. `tailwind.config.ts` replaces Tailwind's palette with these tokens, so `bg-slate-900` compiles to
  nothing; use `bg-surface`, `text-muted`, `border-line` and the rest.
- Dark and light: an inline script in `index.html` sets `data-theme` before first paint from the stored
  choice (`localStorage["ekeeper:theme"]`), else the system preference. `components/ThemeSwitch.tsx` changes it.
- Component classes (`.card`, `.btn`, `.input`, `.chip`, `.tag`, `.warn-box`) are in `src/index.css`
  under `@layer components`. Controls grow to 44px under 720px wide.
- The issue grid collapses on the list's own width (container query), not the viewport, because the
  sidebar takes 220px at tablet widths.
- The owner picker and the status split button are disclosures of plain buttons (`components/usePopover.ts`:
  focus into the panel on open, Escape back to the trigger, Tab out closes), not `role="menu"`.

## Data

- TanStack Query. 400, 401, 403 and 404 are never retried; anything else retries twice.
- Session: `api.me` resolves a 401 to `null` (`lib/session.ts`), so signed out is a cached value, not an error.
  A 401 on any other query or mutation writes `null` into the `["me"]` query (`endSession` in `main.tsx`) and
  `ProtectedLayout` redirects to `/login`. Never remove or invalidate `["me"]` from a handler: the layout has
  it mounted and refetches it at once, which looped a signed-out user on the loader.
  A failure of `/api/me` that is not a 401 (a 5xx, no network) shows "Couldn't reach eKeeper" with Try again
  and does not redirect.
  The cache belongs to one user: logout and a 401 call `endSession` (`lib/session.ts`), which removes every cached
  query except `["me"]` and sets that to `null`. Tabs share one cookie jar, so `useSessionSync` posts the signed
  in user's id (or `null`) on a `BroadcastChannel` and a tab holding a different user drops its cache and
  refetches `["me"]`; without that, Back in a second tab rendered the previous user's cached list.
- Ids in URLs: ids are data, and a group id is a sender's fingerprint verbatim, so it can hold `/`, `..` or `?`.
  Build request paths with the `path` tag and issue routes with `issuePath` (`lib/url.ts`); never interpolate an
  id raw. `url.test.ts` fails on a raw interpolation in `api.ts`. The detail page reads its ids back with
  `idsFromIssuePath(location.pathname)`, not `useParams`: the router decodes `%2F` in a param twice.
- `RouteErrorBoundary` wraps the routed content (and the issue detail again): a render error shows a message with
  a way back and is logged, instead of blanking the app. Parse payload JSON with `parseMaybeJson`, which only
  returns the shape the caller reads.
  Any failed mutation shows a toast unless the mutation handles its own error.
- **Issues list** loads up to 500 rows of the current view (five pages of 100) through
  `fetchIssueSet`. Status, assignee, project, affected user and range go to the API; search, severity,
  "new in 24h" and sort run in the browser on those rows. Above 500 the page says so. The set counts as
  complete only when every page reports the same total; otherwise it refetches once and then shows a
  "list changed while loading" notice.
- **Times**: ClickHouse sends UTC without a zone. Always go through `lib/time.ts` (`parseServerTime`,
  `formatRelative`, `formatAbsolute`); never `new Date(serverValue)`. Absolute times print their zone.
- **Status and owner changes** go through `components/workflow.tsx`. No optimistic update: the toast
  follows the server's answer. A failed change is treated as unknown (the backend writes before its last
  step can fail), so both list and detail refetch.

## Permissions

`lib/permissions.ts` mirrors the backend guards in `backend/src/lib/auth.ts` and the
`requireWorkspaceRole` calls in `backend/src/routes/api.ts`, so a control renders exactly when its call
would succeed. The backend stays the authority. When a backend guard changes, change the matching rule
and its table test in `permissions.test.ts`.

- Close, assign and GitHub edits: admin, or a manager membership on that project.
- Settings sections: Members and Source maps for admin and workspace viewer; Server for admin only.

## Tests and checks

```bash
npm test --prefix frontend      # node:test over src/**/*.test.ts, Node 22.6+, no browser
npm run build --prefix frontend  # tsc --noEmit, then vite build
```

There is no component or browser test runner; pages stay thin so the logic worth testing sits in `lib/`.
