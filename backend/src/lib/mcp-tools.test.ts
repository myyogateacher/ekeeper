import { describe, expect, test } from "bun:test";
import { buildWhere, MCP_TOOLS, getTool } from "./mcp-tools";

test("buildWhere constrains to allowed project ids + time", () => {
  const { clause, params } = buildWhere(["pA", "pB"], {});
  expect(clause).toContain("project_id IN");
  expect(params.project_ids).toEqual(["pA", "pB"]);
  expect(clause).toContain("timestamp >=");
});
test("buildWhere with empty allowed set uses __none__ sentinel", () => {
  const { clause, params } = buildWhere([], {});
  expect(params.project_ids).toEqual(["__none__"]);
  expect(clause).toContain("project_id IN");
});
test("buildWhere ignores project arg not in allowed set", () => {
  const { clause, params } = buildWhere(["pA"], { project: "pB" });
  expect((params as Record<string, unknown>).project).toBeUndefined();
  expect(clause).toContain("project_id IN");
});
test("buildWhere applies project arg when in allowed set", () => {
  const { params } = buildWhere(["pA"], { project: "pA" });
  expect((params as Record<string, unknown>).project).toBe("pA");
});
test("six tools incl list_projects", () => {
  expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(
    ["error_trend", "get_event", "list_projects", "project_info", "search_events", "top_issues"]);
  expect(getTool("error_trend")).toBeDefined();
});
