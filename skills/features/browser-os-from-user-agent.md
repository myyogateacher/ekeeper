# Browser, OS and device from the User-Agent

Web events carry no `contexts.browser`, `contexts.os` or `contexts.device`, so
those columns used to be stored blank for every browser event. Ingest now
falls back to the request's User-Agent for each field the contexts left empty.

## How it works

1. The Sentry browser SDK puts the page's User-Agent under
   `request.headers["User-Agent"]` (server SDKs send it lowercase).
2. `normalizeEvent` (`backend/src/lib/ingest.ts`) keeps the context value when
   there is one and otherwise uses `parseUserAgent(userAgentOf(payload.request))`,
   per field. Mobile SDKs that send contexts are unchanged.
3. `parseUserAgent` (`backend/src/lib/user-agent.ts`) matches an ordered table
   of browser names and an ordered table of OS names. Unknown stays blank.

## Operational notes

- New events only. Events stored before this change keep blank browser, os
  and device; there is no backfill.
- Labels: Facebook, Instagram, HeadlessChrome, Samsung Internet, Edge, Opera,
  Firefox, Android WebView, Chrome, Safari. OS: iOS, Android, Windows, macOS, Linux.
- Chrome on iOS (CriOS) and Firefox on iOS (FxiOS) are labelled Chrome and
  Firefox; the OS column says iOS.
- `device` is filled only for iPhone, iPad and an Android model. Chrome 110+ on
  Android sends the placeholder model `K`, which is stored as blank.
- Android WebViews (the `; wv)` marker) are not Chrome. An iOS WKWebView has
  no marker and no Safari token, so its browser stays blank.
- iPadOS 13+ Safari sends a Macintosh User-Agent and is reported as macOS.
- The MCP `browser` filter is an exact match on these labels.

## How to extend

Add a row to `BROWSER_PATTERNS` or `OS_PATTERNS` in `user-agent.ts`, placed
before any row whose token the new browser's User-Agent also contains, and add
its real User-Agent string to the table in `user-agent.test.ts`.
