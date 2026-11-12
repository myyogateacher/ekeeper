import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPathAfterLogin, isAppPath, peekPathAfterLogin, rememberPathForLogin } from "./after-login.ts";

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
