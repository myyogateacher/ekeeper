import { test } from "node:test";
import assert from "node:assert/strict";
import { canWriteProject, visibleSettingsSections } from "./permissions.ts";
import type { ProjectMembershipRole, UserRole } from "@ekeeper/shared";

function me(role: UserRole, memberships: Array<[string, ProjectMembershipRole]> = []) {
  return {
    user: { id: "u1", email: "u1@example.test", name: "U1", avatarUrl: null, role, status: "active" as const, createdAt: "", updatedAt: "" },
    memberships: memberships.map(([projectId, membershipRole]) => ({ userId: "u1", projectId, role: membershipRole, createdAt: "" })),
  };
}

// Expected values are copied from requireProjectAccess (backend/src/lib/auth.ts:269-285): admin always;
// otherwise a manager membership on that project. The viewer-with-manager-membership row is the case the
// first plan got wrong ("viewer sees no Assign or Close").
test("Close and Assign are offered exactly when the backend's project write rule passes", () => {
  const cases: Array<[string, ReturnType<typeof me>, boolean]> = [
    ["admin, no membership", me("admin"), true],
    ["workspace viewer, no membership", me("viewer"), false],
    ["workspace viewer, manager membership on A", me("viewer", [["A", "manager"]]), true],
    ["workspace viewer, viewer membership on A", me("viewer", [["A", "viewer"]]), false],
    ["workspace manager, manager membership on A", me("manager", [["A", "manager"]]), true],
    ["workspace manager, manager membership on B only", me("manager", [["B", "manager"]]), false],
    ["workspace manager, no membership", me("manager"), false],
  ];
  for (const [label, user, expected] of cases) {
    assert.equal(canWriteProject(user, "A"), expected, label);
  }
});

// Expected lists come from the requireWorkspaceRole calls on each section's read endpoint.
test("each Settings section is visible exactly to the roles the backend lets read it", () => {
  assert.deepEqual(visibleSettingsSections(me("admin")), ["projects", "members", "source-maps", "github", "mcp", "server"]);
  assert.deepEqual(visibleSettingsSections(me("viewer")), ["projects", "members", "source-maps", "github", "mcp"]);
  assert.deepEqual(visibleSettingsSections(me("manager", [["A", "manager"]])), ["projects", "github", "mcp"]);
});
