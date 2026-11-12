import { test } from "node:test";
import assert from "node:assert/strict";
import { isAppPath } from "./after-login.ts";

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
