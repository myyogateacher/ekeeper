// A logged-out click on a GitHub issue's eKeeper link (/errors/<project>/<group>) goes to /login, through
// Google, and the backend always lands the user on /dashboard (backend/src/routes/auth.ts:25). Without
// this the issue they clicked is lost. The path is kept in sessionStorage (this tab only, gone when it
// closes) and only same-origin app paths are restored, so it cannot be used as an open redirect.
const KEY = "ekeeper:after-login";

export function rememberPathForLogin(path: string): void {
  if (!isAppPath(path) || path.startsWith("/login")) {
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

/** A path inside this app: starts with one slash, not "//host" (protocol-relative) or "/\host". */
export function isAppPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
