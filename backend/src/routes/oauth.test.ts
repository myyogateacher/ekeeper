import { describe, expect, test } from "bun:test";
import { asMetadata } from "./oauth";

test("AS metadata advertises endpoints + S256", () => {
  const m = asMetadata("https://glitch.example.com");
  expect(m.authorization_endpoint).toBe("https://glitch.example.com/oauth/authorize");
  expect(m.token_endpoint).toBe("https://glitch.example.com/oauth/token");
  expect(m.registration_endpoint).toBe("https://glitch.example.com/oauth/register");
  expect(m.code_challenge_methods_supported).toEqual(["S256"]);
});
