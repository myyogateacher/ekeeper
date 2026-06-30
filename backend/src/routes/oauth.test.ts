import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { asMetadata, oauthRouter } from "./oauth";
import { registerClient } from "../lib/oauth-store";
import type { AuthedContext } from "../types/api";

test("AS metadata advertises endpoints + S256", () => {
  const m = asMetadata("https://glitch.example.com");
  expect(m.authorization_endpoint).toBe("https://glitch.example.com/oauth/authorize");
  expect(m.token_endpoint).toBe("https://glitch.example.com/oauth/token");
  expect(m.registration_endpoint).toBe("https://glitch.example.com/oauth/register");
  expect(m.code_challenge_methods_supported).toEqual(["S256"]);
});

describe("GET /oauth/authorize", () => {
  // Build a small test app that injects a fake auth session via middleware,
  // then mounts the real oauthRouter so all production logic runs.
  function buildApp(authedUser?: { id: string }) {
    const app = new Hono();
    app.use("*", async (ctx, next) => {
      if (authedUser) {
        ctx.set("auth", { user: { id: authedUser.id } } as unknown as AuthedContext);
      }
      await next();
    });
    app.route("/", oauthRouter);
    return app;
  }

  function authorizeUrl(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return `http://localhost/oauth/authorize?${qs}`;
  }

  const REDIRECT = "http://localhost:9999/cb";
  const CHALLENGE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // valid base64url-encoded SHA-256

  test("happy path: 302 to redirect_uri with code and state", async () => {
    const client = registerClient([REDIRECT], "Test Client");
    const app = buildApp({ id: "u1" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "xyz123",
      }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const dest = new URL(location);
    expect(dest.origin + dest.pathname).toBe(REDIRECT);
    expect(dest.searchParams.get("code")).toBeTruthy();
    expect(dest.searchParams.get("state")).toBe("xyz123");
  });

  test("happy path without state: no state param in redirect", async () => {
    const client = registerClient([REDIRECT], "No State Client");
    const app = buildApp({ id: "u2" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const dest = new URL(location);
    expect(dest.searchParams.has("state")).toBe(false);
    expect(dest.searchParams.get("code")).toBeTruthy();
  });

  test("no session: 302 to frontend /?next=...", async () => {
    const client = registerClient([REDIRECT], "Anon Client");
    const app = buildApp(); // no authedUser → no auth context

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "s1",
      }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    // Should redirect to the frontend login page with next= param.
    expect(location).toMatch(/\?next=/);
    expect(location).toMatch(/oauth%2Fauthorize/);
  });

  test("bad response_type → 400", async () => {
    const client = registerClient([REDIRECT], "Bad RT Client");
    const app = buildApp({ id: "u3" });

    const res = await app.request(
      authorizeUrl({
        response_type: "token", // not "code"
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unsupported_response_type");
  });

  test("bad code_challenge_method → 400", async () => {
    const client = registerClient([REDIRECT], "Bad CCM Client");
    const app = buildApp({ id: "u4" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "plain", // must be S256
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("PKCE S256 required");
  });

  test("missing code_challenge → 400", async () => {
    const client = registerClient([REDIRECT], "Missing CC Client");
    const app = buildApp({ id: "u5" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge_method: "S256",
        // code_challenge omitted
      }),
    );

    expect(res.status).toBe(400);
  });

  test("unknown client_id → 400", async () => {
    const app = buildApp({ id: "u6" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: "mcpc_doesnotexist",
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid client_id or redirect_uri");
  });

  test("mismatched redirect_uri → 400", async () => {
    const client = registerClient(["http://allowed.example.com/cb"], "Mismatch Client");
    const app = buildApp({ id: "u7" });

    const res = await app.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://evil.example.com/cb", // not in client's registered URIs
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid client_id or redirect_uri");
  });
});
