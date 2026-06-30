import { describe, expect, test } from "bun:test";
import { handleRpc } from "./mcp";

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
