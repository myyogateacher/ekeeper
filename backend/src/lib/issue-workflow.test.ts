import { afterAll, describe, expect, test } from "bun:test";
import { one, run } from "../db/sqlite";
import { upsertIssueWorkflow } from "./issue-workflow";

// closed_at is what the issue page shows as "Closed 2h ago". It has to be the moment the issue was closed, so a
// write that does not close it, such as assigning a closed issue, must leave it where it was.
const suffix = Math.random().toString(36).slice(2, 8);
const projectId = `p_wf_${suffix}`;
const now = new Date().toISOString();
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [projectId, `Workflow ${suffix}`, `wf-${suffix}`, "production", 1, now, now]);
afterAll(() => {
  run(`DELETE FROM issue_workflows WHERE project_id = ?`, [projectId]);
  run(`DELETE FROM projects WHERE id = ?`, [projectId]);
});

const row = (groupId: string) =>
  one<{ state: string; closedAt: string | null }>(`SELECT state, closed_at AS closedAt FROM issue_workflows WHERE project_id = ? AND group_id = ?`, [projectId, groupId])!;
const longAgo = "2026-01-01T00:00:00.000Z";
// Closes the issue, then moves closed_at back so a later write that re-stamps it is visible.
const closedLongAgo = (groupId: string) => {
  upsertIssueWorkflow(projectId, groupId, { state: "closed" });
  run(`UPDATE issue_workflows SET closed_at = ? WHERE project_id = ? AND group_id = ?`, [longAgo, projectId, groupId]);
};

describe("upsertIssueWorkflow closed_at", () => {
  test("closing an issue stamps closed_at", () => {
    upsertIssueWorkflow(projectId, "g_close", { state: "closed" });

    expect(row("g_close").state).toBe("closed");
    expect(row("g_close").closedAt).not.toBeNull();
  });

  test("assigning a closed issue keeps the time it was closed", () => {
    closedLongAgo("g_assign");

    upsertIssueWorkflow(projectId, "g_assign", { assignedUserId: null });

    expect(row("g_assign")).toEqual({ state: "closed", closedAt: longAgo });
  });

  test("closing an already closed issue again keeps the original time", () => {
    closedLongAgo("g_again");

    upsertIssueWorkflow(projectId, "g_again", { state: "closed" });

    expect(row("g_again").closedAt).toBe(longAgo);
  });

  test("reopening clears closed_at, and closing it again stamps a new one", () => {
    closedLongAgo("g_reopen");

    upsertIssueWorkflow(projectId, "g_reopen", { state: "reopened" });
    expect(row("g_reopen")).toEqual({ state: "reopened", closedAt: null });

    upsertIssueWorkflow(projectId, "g_reopen", { state: "closed" });
    expect(row("g_reopen").closedAt).not.toBe(longAgo);
    expect(row("g_reopen").closedAt).not.toBeNull();
  });

  test("an issue that was never closed has no closed_at", () => {
    upsertIssueWorkflow(projectId, "g_open", { assignedUserId: null });

    expect(row("g_open")).toEqual({ state: "open", closedAt: null });
  });
});
