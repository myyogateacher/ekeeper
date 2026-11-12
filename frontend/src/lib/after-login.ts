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

export function takePathAfterLogin(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path && isAppPath(path) ? path : null;
  } catch (error) {
    console.warn("Could not read the page to return to after login:", error);
    return null;
  }
}

/** A path inside this app: starts with one slash, not "//host" (protocol-relative) or "/\host". */
export function isAppPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
