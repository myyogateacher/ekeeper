import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPathAfterLogin, isAppPath, isLandingPath, peekPathAfterLogin, rememberPathForLogin } from "./after-login.ts";

// The remembered path is navigated to after sign-in, so anything that could leave the app (a
// protocol-relative or backslash path, a full URL) must be refused, or a crafted link becomes a redirect
// to another site with the user freshly signed in.
test("only same-origin app paths are restored after login", () => {
  assert.equal(isAppPath("/errors/p1/g1?event=e1"), true);
  assert.equal(isAppPath("//evil.example/errors"), false);
  assert.equal(isAppPath("/\\evil.example"), false);
  assert.equal(isAppPath("https://evil.example"), false);
  assert.equal(isAppPath("errors"), false);
});

// URL parsing deletes tabs and newlines wherever they sit, so "/\t/evil.example" is "//evil.example" to a
// browser although it does not start with "//" as a string. A string prefix check alone let it through; the
// parsed origin is the check that matches what the browser will do.
test("a tab, newline or carriage return cannot smuggle a second slash past the check", () => {
  for (const path of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\t\\evil.example", "/\u0000/evil.example"]) {
    assert.equal(isAppPath(path), false, JSON.stringify(path));
  }
  assert.equal(isAppPath("/errors?x=a b"), true);
});

// sessionStorage is a browser global; node has none by default, so each test installs a plain Map behind
// the same three calls the module makes.
function withSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

// React renders a component twice under StrictMode and may render it more than once in production, so the
// redirect that restores the deep link reads the path during render. A read that removed the path made the
// second render find nothing and send the user to /errors (PROD-10519 QA, dev server). Only clearing forgets it.
test("reading the remembered path twice gives the same answer; only clearing forgets it", () => {
  withSessionStorage();
  rememberPathForLogin("/errors/p1/g1?event=e1");
  assert.equal(peekPathAfterLogin(), "/errors/p1/g1?event=e1");
  assert.equal(peekPathAfterLogin(), "/errors/p1/g1?event=e1");
  clearPathAfterLogin();
  assert.equal(peekPathAfterLogin(), null);
});

test("a stored path that is not an app path is never returned, and /login is never remembered", () => {
  withSessionStorage({ "ekeeper:after-login": "//evil.example/errors" });
  assert.equal(peekPathAfterLogin(), null);
  const store = withSessionStorage();
  rememberPathForLogin("/login?next=1");
  assert.equal(store.size, 0);
});

// A path that renders RedirectAfterLogin cannot be the place it sends the user: the router is already on
// that route, the redirect's <Navigate> does not fire again, and the page renders nothing. /dashboard is where
// every sign-in lands (backend/src/routes/auth.ts:25) and the old home page, so a signed-out user opening it
// is the likely case (PROD-10519 review: blank page after signing in). Both routes that render the redirect
// are checked, in the spellings the router treats as the same route (trailing slash, case, query, hash).
test("a route that itself redirects after login is never remembered as the page to return to", () => {
  for (const landing of ["/dashboard", "/dashboard/", "/Dashboard", "/dashboard?x=1", "/dashboard#top", "/login", "/login/", "/login?next=1"]) {
    const store = withSessionStorage();
    rememberPathForLogin(landing);
    assert.equal(store.size, 0, landing);
    assert.equal(isLandingPath(landing), true, landing);
  }
  for (const page of ["/errors", "/errors?x=1", "/errors/p1/g1", "/dashboardx", "/settings/members"]) {
    const store = withSessionStorage();
    rememberPathForLogin(page);
    assert.equal(store.size, 1, page);
  }
});

// The block is module state, so each case loads its own copy of the module: one test's logout must not stop the
// next test's expiry from remembering. (A page reload gives the real app the same fresh copy.)
type AfterLogin = typeof import("./after-login.ts");
let copies = 0;
const freshAfterLogin = (): Promise<AfterLogin> => import(`./after-login.ts?copy=${++copies}`);

// ProtectedLayout calls rememberPathForLogin while rendering. On Log out, endSession sets the session to null,
// the layout re-renders on the old page before the /login navigation lands, and that render wrote the page
// back after the logout had cleared it (PROD-10519 review); tab B's logout did the same in an idle tab A, and
// the next user signing in followed A to the previous user's last page. An explicit logout, here or received
// from another tab, forgets the page and keeps it forgotten until the page reloads (Google sign-in is a full
// page load, so the block ends by itself).
test("a page is never remembered after a logout in this tab or another, however many renders follow", async () => {
  const store = withSessionStorage({ "ekeeper:after-login": "/settings/github" });
  const login = await freshAfterLogin();
  login.forgetPathAfterLogout();
  assert.equal(store.size, 0, "the remembered page is cleared");
  login.rememberPathForLogin("/errors/p1/busy");
  login.rememberPathForLogin("/errors/p1/busy?event=e1");
  assert.equal(store.size, 0, "renders after the logout cannot write it back");
  assert.equal(login.peekPathAfterLogin(), null);
});

test("an expired session still remembers the page it was on", async () => {
  const store = withSessionStorage();
  const login = await freshAfterLogin();
  login.rememberPathForLogin("/errors/p1/busy");
  assert.equal(login.peekPathAfterLogin(), "/errors/p1/busy");
  assert.equal(store.size, 1);
});
