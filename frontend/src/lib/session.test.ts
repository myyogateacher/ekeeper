import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api-error.ts";
import { userOrSignedOut } from "./session.ts";

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
