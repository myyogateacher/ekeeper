import { describe, expect, test } from "bun:test";
import { getMcpSecretKey, regenerateMcpSecretKey } from "./server-settings";

describe("MCP secret key", () => {
  test("getMcpSecretKey is stable across calls and well-formed", () => {
    const a = getMcpSecretKey();
    const b = getMcpSecretKey();
    expect(a).toBe(b);
    expect(a).toMatch(/^mcpk_[0-9a-f]{48}$/);
  });

  test("regenerateMcpSecretKey changes the stored key", () => {
    const before = getMcpSecretKey();
    const rotated = regenerateMcpSecretKey();
    expect(rotated).not.toBe(before);
    expect(rotated).toMatch(/^mcpk_[0-9a-f]{48}$/);
    expect(getMcpSecretKey()).toBe(rotated);
  });
});
