// A logged-out click on a GitHub issue's eKeeper link (/errors/<project>/<group>) goes to /login, through
// Google, and the backend always lands the user on /dashboard (backend/src/routes/auth.ts:25). Without
// this the issue they clicked is lost. The path is kept in sessionStorage (this tab only, gone when it
// closes) and only same-origin app paths are restored, so it cannot be used as an open redirect.
const KEY = "ekeeper:after-login";

/**
 * The two routes that render the post-login redirect: /login (when already signed in) and /dashboard, where
 * the backend lands every sign-in. Neither can be the page to return to, because the router is already on it
 * and the redirect's <Navigate> does not fire again, so the page stays blank. Compared the way the router
 * matches: query and hash ignored, trailing slashes ignored, case ignored.
 */
export function isLandingPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, "").toLowerCase();
  return pathname === "/dashboard" || pathname === "/login";
}

export function rememberPathForLogin(path: string): void {
  if (!isAppPath(path) || isLandingPath(path)) {
    return;
  }
  try {
    sessionStorage.setItem(KEY, path);
  } catch (error) {
    // Storage blocked (private mode, policy): the user lands on the issues list instead. Nothing breaks.
    console.warn("Could not remember the page to return to after login:", error);
  }
}

/**
 * The remembered path, or null. Reading does not remove it: the redirect that uses it runs during render,
 * which React repeats (StrictMode renders twice in development and concurrent rendering may re-render in
 * production), and a read that consumed the path left the second render with nothing, so the user landed on
 * the issues list instead of the issue they clicked. The caller clears it with clearPathAfterLogin in an
 * effect, which runs once per commit.
 */
export function peekPathAfterLogin(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    return path && isAppPath(path) ? path : null;
  } catch (error) {
    console.warn("Could not read the page to return to after login:", error);
    return null;
  }
}

export function clearPathAfterLogin(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch (error) {
    console.warn("Could not clear the page to return to after login:", error);
  }
}

// Any origin works: it is only compared with itself to see whether a path stays on it.
const PROBE_ORIGIN = "http://app.invalid";

/**
 * A path inside this app: starts with one slash and resolves to the same origin. The string checks refuse
 * "//host" (protocol-relative) and "/\host" (browsers read the backslash as a slash). Control characters are
 * refused outright, because URL parsing deletes tabs and newlines wherever they sit, so "/<tab>/host" is
 * "//host" to a browser. The parse then confirms it from the browser's own rules rather than from a list of
 * known tricks.
 */
export function isAppPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    return false;
  }
  return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN;
}
