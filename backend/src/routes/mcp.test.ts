import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { handleRpc, mcpRouter } from "./mcp";
import { issueTokens } from "../lib/oauth-store";
import { getMcpSecretKey } from "../lib/server-settings";
import { run } from "../db/sqlite";

test("tools/list returns the six tools", async () => {
  const res = (await handleRpc(["pA"], { jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
  expect(res!.result.tools.map((t: any) => t.name).sort()).toEqual(
    ["error_trend", "get_event", "list_projects", "project_info", "search_events", "top_issues"]);
});

test("initialize advertises protocol", async () => {
  const res = (await handleRpc(["pA"], { jsonrpc: "2.0", id: 2, method: "initialize" })) as any;
  expect(res!.result.protocolVersion).toBe("2024-11-05");
});

test("initialize returns full server info", async () => {
  const res = (await handleRpc(["pA"], { jsonrpc: "2.0", id: 3, method: "initialize" })) as any;
  expect(res!.result.serverInfo).toEqual({ name: "ekeeper", version: "0.1.0" });
  expect(res!.result.capabilities).toEqual({ tools: {} });
});

test("notifications/initialized returns null (202 ack)", async () => {
  const res = await handleRpc(["pA"], { jsonrpc: "2.0", id: 4, method: "notifications/initialized" });
  expect(res).toBeNull();
});

test("unknown method returns -32601", async () => {
  const res = (await handleRpc(["pA"], { jsonrpc: "2.0", id: 5, method: "unknown/method" })) as any;
  expect(res!.error.code).toBe(-32601);
});

test("tools/call with unknown tool returns -32602", async () => {
  const res = (await handleRpc(["pA"], { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nonexistent", arguments: {} } })) as any;
  expect(res!.error.code).toBe(-32602);
});

// Seed a real active user so accessibleProjectIds doesn't throw
const httpTestSuffix = Math.random().toString(36).slice(2, 8);
const httpTestUserId = `u_http_${httpTestSuffix}`;
const now = new Date().toISOString();
run(`INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [httpTestUserId, `http_test_${httpTestSuffix}@test.example`, "HTTP Test", "viewer", "active", now, now]);

afterAll(() => {
  run(`DELETE FROM users WHERE id = ?`, [httpTestUserId]);
});

describe("HTTP /mcp auth", () => {
  const app = new Hono();
  app.route("/mcp", mcpRouter);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  test("POST /mcp with no Authorization → 401 with WWW-Authenticate containing resource_metadata=", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toContain("resource_metadata=");
  });

  test("POST /mcp with invalid bearer → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer not-a-real-token" },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with valid token → 200 and tools/list returns 6 tools", async () => {
    const t = await issueTokens(httpTestUserId, "c_http_test");
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${t.accessToken}` },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.tools).toHaveLength(6);
  });

  test("POST /mcp with the MCP secret key → 200 and tools/list returns 6 tools", async () => {
    const key = getMcpSecretKey();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.tools).toHaveLength(6);
  });

  test("POST /mcp with a wrong secret key → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer mcpk_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("GET /mcp → 401 with WWW-Authenticate header present", async () => {
    const res = await app.request("/mcp", { method: "GET" });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain("resource_metadata=");
  });
});
