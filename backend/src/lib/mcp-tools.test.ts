import { afterAll, describe, expect, test } from "bun:test";
import { buildWhere, MCP_TOOLS, getTool, accessibleProjectIds } from "./mcp-tools";
import { run, all } from "../db/sqlite";
import { HttpError } from "./http";

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

// ── accessibleProjectIds tests ────────────────────────────────────────────────

const suffix = Math.random().toString(36).slice(2, 8);
const userId_admin = `user_admin_${suffix}`;
const userId_member = `user_member_${suffix}`;
const userId_disabled = `user_disabled_${suffix}`;
const userId_unknown = `user_unknown_${suffix}`; // never inserted
const projectId_a = `proj_a_${suffix}`;
const projectId_b = `proj_b_${suffix}`;
const now = new Date().toISOString();

// Seed data
run(`INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [userId_admin, `admin_${suffix}@test.example`, "Admin", "admin", "active", now, now]);
run(`INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [userId_member, `member_${suffix}@test.example`, "Member", "manager", "active", now, now]);
run(`INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [userId_disabled, `disabled_${suffix}@test.example`, "Disabled", "admin", "disabled", now, now]);

run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [projectId_a, `Proj A ${suffix}`, `proj-a-${suffix}`, "production", 1, now, now]);
run(`INSERT INTO projects (id, name, slug, environment, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [projectId_b, `Proj B ${suffix}`, `proj-b-${suffix}`, "staging", 1, now, now]);

// member only belongs to project A
run(`INSERT INTO project_memberships (user_id, project_id, role, created_at) VALUES (?, ?, ?, ?)`,
  [userId_member, projectId_a, "manager", now]);

afterAll(() => {
  // Clean up seeded rows
  run(`DELETE FROM project_memberships WHERE user_id IN (?, ?, ?)`, [userId_admin, userId_member, userId_disabled]);
  run(`DELETE FROM projects WHERE id IN (?, ?)`, [projectId_a, projectId_b]);
  run(`DELETE FROM users WHERE id IN (?, ?, ?)`, [userId_admin, userId_member, userId_disabled]);
});

describe("accessibleProjectIds", () => {
  test("admin gets all active project ids", () => {
    const ids = accessibleProjectIds(userId_admin);
    expect(ids).toContain(projectId_a);
    expect(ids).toContain(projectId_b);
  });

  test("active member gets exactly their membership ids, not another user's project", () => {
    const ids = accessibleProjectIds(userId_member);
    expect(ids).toContain(projectId_a);
    expect(ids).not.toContain(projectId_b);
  });

  test("disabled user throws HttpError 401", () => {
    expect(() => accessibleProjectIds(userId_disabled)).toThrow(HttpError);
    try {
      accessibleProjectIds(userId_disabled);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(401);
    }
  });

  test("unknown userId throws HttpError 401", () => {
    expect(() => accessibleProjectIds(userId_unknown)).toThrow(HttpError);
    try {
      accessibleProjectIds(userId_unknown);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(401);
    }
  });
});
