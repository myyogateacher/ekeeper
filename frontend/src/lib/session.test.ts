import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api-error.ts";
import { QueryClient } from "@tanstack/react-query";
import { dropCachedQueries, endSession, mustDropCache, parseSessionMessage, userOrSignedOut } from "./session.ts";

// The loop this prevents (PROD-10519 QA, about 3,900 GET /api/me in 3 s, never reaching /login): the session
// query used to fail with a 401 when signed out, a cache-wide handler reacted to that failure by clearing the
// query, and the mounted observer refetched it, which failed with a 401 again. A signed-out answer has to be
// a value the cache can hold, so there is no failure for the handler to react to.
test("signed out resolves to no user, never to an error that retriggers the session fetch", async () => {
  assert.equal(await userOrSignedOut(() => Promise.reject(new ApiError("Unauthorized", 401))), null);
});

test("a signed in user is returned untouched", async () => {
  const me = { user: { id: "u1" } };
  assert.equal(await userOrSignedOut(() => Promise.resolve(me)), me);
});

// If every failure became null, an outage or a 500 on /api/me would be indistinguishable from a signed-out
// user: they would be sent to login and bounced back in a loop of their own.
test("only a 401 means signed out; a refusal, a server error or a network failure stays an error", async () => {
  for (const failure of [new ApiError("Forbidden", 403), new ApiError("Internal server error", 500), new TypeError("Failed to fetch")]) {
    await assert.rejects(userOrSignedOut(() => Promise.reject(failure)), (error) => error === failure);
  }
});

// PROD-10519 QA and security: on a shared browser, tab A (admin) opened an issue, tab B signed out and signed
// in as another user, and tab A's Back rendered the admin's cached list under the admin's name. No request in
// tab A ever returned a 401, so nothing cleared the cache. The cache belongs to one user: when the session
// ends, every query except the session's own goes with it. The session query is kept and set to null, never
// removed: ProtectedLayout has it mounted, and removing it refetches it at once (the loop of 615d469).
test("ending the session removes every cached query except the session's, which becomes null", () => {
  const client = new QueryClient();
  client.setQueryData(["me"], { user: { id: "admin" } });
  client.setQueryData(["errors", "set", "open"], { rows: ["admin's issues"] });
  client.setQueryData(["projects"], { projects: ["admin's project"] });
  client.setQueryData(["error-detail", "p", "g", undefined], { error: "admin's issue" });
  endSession(client);
  assert.equal(client.getQueryData(["me"]), null);
  assert.equal(client.getQueryState(["me"])?.status, "success");
  assert.equal(client.getQueryData(["errors", "set", "open"]), undefined);
  assert.equal(client.getQueryData(["projects"]), undefined);
  assert.equal(client.getQueryData(["error-detail", "p", "g", undefined]), undefined);
  assert.equal(client.getQueryCache().getAll().length, 1);
});

// Tabs share one cookie jar, so a sign in or out in one tab changes who every tab is. Each tab posts the user
// it is signed in as; a tab that holds a different user's data must drop it and ask who it is now.
test("a session message from another tab drops the cache unless it names the same user", () => {
  assert.equal(mustDropCache("admin", { userId: "admin" }), false);
  assert.equal(mustDropCache("admin", { userId: "manager" }), true);
  assert.equal(mustDropCache("admin", { userId: null }), true);
  assert.equal(mustDropCache(null, { userId: "manager" }), true);
  assert.equal(mustDropCache(null, { userId: null }), false);
});

test("a malformed session message is ignored, not read as a sign out", () => {
  assert.deepEqual(parseSessionMessage({ userId: "u1" }), { userId: "u1" });
  assert.deepEqual(parseSessionMessage({ userId: null }), { userId: null });
  for (const junk of [null, undefined, "u1", 7, [], {}, { userId: 7 }, { userId: undefined }]) {
    assert.equal(parseSessionMessage(junk), null, JSON.stringify(junk));
  }
});

// The cross-tab drop keeps mounted pages from showing the previous user's rows: queries are reset (their data
// is gone at once and active ones refetch under the cookie the tab now has), and the session query is only
// refetched, never reset, so the shell does not flash the signed-out redirect.
test("dropping cached queries resets all but the session's, which keeps its data until refetched", () => {
  const client = new QueryClient();
  client.setQueryData(["me"], { user: { id: "admin" } });
  client.setQueryData(["errors", "set", "open"], { rows: ["admin's issues"] });
  dropCachedQueries(client);
  assert.deepEqual(client.getQueryData(["me"]), { user: { id: "admin" } });
  assert.equal(client.getQueryData(["errors", "set", "open"]), undefined);
});
