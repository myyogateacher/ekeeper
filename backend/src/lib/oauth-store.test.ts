import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyPkce, registerClient, getClient, issueCode, consumeCode, issueTokens, validateAccessToken } from "./oauth-store";

describe("oauth-store", () => {
  test("verifyPkce S256", () => {
    const verifier = "abc123abc123abc123abc123abc123abc1";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("wrong", challenge)).toBe(false);
  });
  test("register + get client", () => {
    const c = registerClient(["http://localhost:9999/cb"], "Test");
    expect(c.client_id).toMatch(/^mcpc_/);
    expect(getClient(c.client_id)?.redirect_uris).toEqual(["http://localhost:9999/cb"]);
  });
  test("code is single-use; tokens validate", async () => {
    const code = await issueCode({ userId: "u1", clientId: "c1", redirectUri: "http://localhost:9999/cb", codeChallenge: "x" });
    const first = await consumeCode(code);
    expect(first?.userId).toBe("u1");
    expect(await consumeCode(code)).toBeNull();           // single-use
    const t = await issueTokens("u1", "c1");
    expect((await validateAccessToken(t.accessToken))?.userId).toBe("u1");
    expect(await validateAccessToken("nope")).toBeNull();
  });
});
