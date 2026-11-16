import { one, run } from "../db/sqlite";
import type { IssueState } from "@ekeeper/shared";

export function upsertIssueWorkflow(
  projectId: string,
  groupId: string,
  input: { state?: IssueState; assignedUserId?: string | null },
) {
  const now = new Date().toISOString();
  const existing = one<{
    state: IssueState;
    assignedUserId: string | null;
    createdAt: string;
    closedAt: string | null;
  }>(
    `SELECT state, assigned_user_id as assignedUserId, created_at as createdAt, closed_at as closedAt
     FROM issue_workflows WHERE project_id = ? AND group_id = ?`,
    [projectId, groupId],
  );

  const state = input.state ?? existing?.state ?? "open";
  const assignedUserId =
    input.assignedUserId === undefined
      ? (existing?.assignedUserId ?? null)
      : input.assignedUserId;
  const createdAt = existing?.createdAt ?? now;
  // closed_at is when the issue was closed, shown on the issue page as "Closed 2h ago". Assigning a closed issue
  // or sending state "closed" again does not close it again, so an existing stamp is kept; without this every
  // assignment made the issue read "closed just now". A closed row with no stamp (null) is stamped now.
  const closedAt = state !== "closed" ? null : existing?.state === "closed" && existing.closedAt ? existing.closedAt : now;

  run(
    `INSERT INTO issue_workflows (project_id, group_id, state, assigned_user_id, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, group_id) DO UPDATE SET
       state = excluded.state,
       assigned_user_id = excluded.assigned_user_id,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at`,
    [projectId, groupId, state, assignedUserId, createdAt, now, closedAt],
  );
}
