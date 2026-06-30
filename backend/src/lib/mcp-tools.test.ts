import { describe, expect, test } from "bun:test";
import { buildWhere, MCP_TOOLS, getTool } from "./mcp-tools";

test("buildWhere constrains to allowed project ids + time", () => {
  const { clause, params } = buildWhere(["pA", "pB"], {});
  expect(clause).toContain("project_id IN");
  expect(params.project_ids).toEqual(["pA", "pB"]);
  expect(clause).toContain("timestamp >=");
});
test("five tools incl list_projects", () => {
  expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(
    ["error_trend", "get_event", "list_projects", "project_info", "search_events", "top_issues"]);
  expect(getTool("error_trend")).toBeDefined();
});
