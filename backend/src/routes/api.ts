import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config";
import { getClickHouseClient } from "../db/clickhouse";
import { all, one, run } from "../db/sqlite";
import { clearUserSessions, requireAuth, requireProjectAccess, requireWorkspaceRole } from "../lib/auth";
import { HttpError } from "../lib/http";
import { createId, randomToken } from "../lib/ids";
import { cleanupExpiredMinimaps, deobfuscateEvent, listMinimapArtifacts, saveMinimapArtifact } from "../lib/minimaps";
import { getServerSettings, regenerateServerAuthToken } from "../lib/server-settings";
import type {
  DashboardProjectCard,
  ErrorEventDetail,
  ErrorGroupSummary,
  IssueState,
  MinimapArtifact,
  Project,
  ProjectKey,
  ProjectMembership,
  ServerSettings,
  User,
} from "@ekeeper/shared";

const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  avatarUrl: z.string().url().nullable().or(z.literal("")).optional(),
  role: z.enum(["admin", "manager", "viewer"]),
  status: z.enum(["active", "disabled"]),
});

const projectSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  environment: z.string().min(1),
  active: z.boolean(),
});

const membershipSchema = z.object({
  role: z.enum(["manager", "viewer"]),
});

const workflowSchema = z.object({
  state: z.enum(["open", "closed", "reopened"]).optional(),
  assignedUserId: z.string().nullable().optional(),
});

const minimapUploadSchema = z.object({
  org: z.string().min(1).default(config.EKEEPER_ORG),
  projectId: z.string().min(1),
  release: z.string().min(1),
  dist: z.string().min(1).nullable().optional(),
  artifactName: z.string().min(1),
});

function buildProjectDsn(publicKey: string, sentryProjectId: string): string {
  return `${config.INGEST_DSN_SCHEME}://${publicKey}@${config.INGEST_DSN_HOST}/api/ingest/${publicKey}/${sentryProjectId}`;
}

function mapProjectRows(authUserId: string, isAdmin: boolean) {
  const rows = all<
    Project & {
      sentryProjectId: string;
      publicKey: string | null;
      secretKey: string | null;
      dsn: string | null;
      keyId: string | null;
    }
  >(
    `
      SELECT p.id, p.name, p.slug, p.sentry_project_id as sentryProjectId, p.environment, p.active, p.created_at as createdAt, p.updated_at as updatedAt,
        pk.id as keyId, pk.public_key as publicKey, pk.secret_key as secretKey, pk.dsn as dsn
      FROM projects p
      LEFT JOIN project_keys pk ON pk.project_id = p.id
      ${isAdmin ? "" : "INNER JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?"}
      ORDER BY p.name ASC
    `,
    isAdmin ? [] : [authUserId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    environment: row.environment,
    active: Boolean(row.active),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
        key: row.keyId
      ? {
          id: row.keyId,
          projectId: row.id,
          publicKey: row.publicKey!,
          secretKey: row.secretKey!,
          dsn: buildProjectDsn(row.publicKey!, row.sentryProjectId),
          createdAt: row.createdAt,
        }
      : null,
  }));
}

function nextSentryProjectId(): string {
  const row = one<{ nextId: number }>(
    "SELECT COALESCE(MAX(CAST(sentry_project_id AS INTEGER)), 0) + 1 AS nextId FROM projects",
  );
  return String(row?.nextId ?? 1);
}

async function dashboardCards(projectIds: string[], projects: Project[]): Promise<DashboardProjectCard[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const client = getClickHouseClient();
  const filter = projectIds.map((id) => `'${id}'`).join(", ");
  const result = await client.query({
    query: `
      SELECT
        project_id AS projectId,
        count() AS totalEvents7d,
        uniq(group_id) AS recurringGroups7d,
        uniqIf(user_id, user_id != '') AS impactedUsers7d,
        any(title) AS topGroupTitle
      FROM events
      WHERE project_id IN (${filter}) AND timestamp >= now() - INTERVAL 7 DAY
      GROUP BY project_id
    `,
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<
    Pick<DashboardProjectCard, "projectId" | "totalEvents7d" | "recurringGroups7d" | "impactedUsers7d" | "topGroupTitle">
  >;
  const byProjectId = new Map(rows.map((row) => [row.projectId, row]));

  return projects.map((project) => {
    const row = byProjectId.get(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      totalEvents7d: Number(row?.totalEvents7d ?? 0),
      recurringGroups7d: Number(row?.recurringGroups7d ?? 0),
      impactedUsers7d: Number(row?.impactedUsers7d ?? 0),
      trendPercent: 0,
      topGroupTitle: row?.topGroupTitle ?? null,
    };
  });
}

async function queryErrorGroups(projectIds: string[]): Promise<ErrorGroupSummary[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const client = getClickHouseClient();
  const filter = projectIds.map((id) => `'${id}'`).join(", ");
  const result = await client.query({
    query: `
      SELECT
        group_id AS groupId,
        project_id AS projectId,
        any(title) AS title,
        any(fingerprint) AS fingerprint,
        countIf(timestamp >= now() - INTERVAL 7 DAY) AS count7d,
        countIf(timestamp >= now() - INTERVAL 1 DAY) AS count24h,
        min(timestamp) AS firstSeen,
        max(timestamp) AS lastSeen,
        any(severity) AS severity,
        uniqIf(user_id, user_id != '') AS affectedUsers
      FROM events
      WHERE project_id IN (${filter})
      GROUP BY project_id, group_id
      ORDER BY count7d DESC, lastSeen DESC
    `,
    format: "JSONEachRow",
  });

  const rows = (await result.json()) as Array<Omit<ErrorGroupSummary, "state" | "assignedUserId" | "assignedUserName">>;
  const workflowRows = all<{
    projectId: string;
    groupId: string;
    state: IssueState;
    assignedUserId: string | null;
    assignedUserName: string | null;
  }>(
    `
      SELECT iw.project_id as projectId, iw.group_id as groupId, iw.state as state,
        iw.assigned_user_id as assignedUserId, u.name as assignedUserName
      FROM issue_workflows iw
      LEFT JOIN users u ON u.id = iw.assigned_user_id
      WHERE iw.project_id IN (${projectIds.map(() => "?").join(", ")})
    `,
    projectIds,
  );
  const workflowByKey = new Map(
    workflowRows.map((row) => [`${row.projectId}:${row.groupId}`, row]),
  );

  return rows.map((row) => {
    const workflow = workflowByKey.get(`${row.projectId}:${row.groupId}`);
    return {
    ...row,
    count7d: Number(row.count7d),
    count24h: Number(row.count24h),
    affectedUsers: Number(row.affectedUsers),
      state: workflow?.state ?? "open",
      assignedUserId: workflow?.assignedUserId ?? null,
      assignedUserName: workflow?.assignedUserName ?? null,
    };
  });
}

function filterErrors(
  errors: ErrorGroupSummary[],
  options: {
    state: string;
    assignment: string;
    assignedUserId?: string;
  },
) {
  return errors.filter((error) => {
    const state = options.state || "open_or_reopened";
    const assignment = options.assignment || "any";

    if (state === "open_or_reopened" && error.state === "closed") {
      return false;
    }

    if (state !== "any" && state !== "open_or_reopened" && error.state !== state) {
      return false;
    }

    if (assignment === "assigned" && !error.assignedUserId) {
      return false;
    }

    if (assignment === "unassigned" && error.assignedUserId) {
      return false;
    }

    if (assignment === "user" && error.assignedUserId !== options.assignedUserId) {
      return false;
    }

    return true;
  });
}

function upsertIssueWorkflow(projectId: string, groupId: string, input: { state?: IssueState; assignedUserId?: string | null }) {
  const now = new Date().toISOString();
  const existing = one<{
    state: IssueState;
    assignedUserId: string | null;
    createdAt: string;
  }>(
    `SELECT state, assigned_user_id as assignedUserId, created_at as createdAt
     FROM issue_workflows WHERE project_id = ? AND group_id = ?`,
    [projectId, groupId],
  );

  const state = input.state ?? existing?.state ?? "open";
  const assignedUserId = input.assignedUserId === undefined ? (existing?.assignedUserId ?? null) : input.assignedUserId;
  const createdAt = existing?.createdAt ?? now;
  const closedAt = state === "closed" ? now : null;

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

export const apiRouter = new Hono();

apiRouter.get("/me", (ctx) => {
  const auth = requireAuth(ctx);
  return ctx.json({
    user: auth.user,
    memberships: auth.memberships,
  });
});

apiRouter.get("/users", (ctx) => {
  requireWorkspaceRole(ctx, ["admin", "viewer"]);
  const users = all<User>(
    `SELECT id, email, name, avatar_url as avatarUrl, role, status, created_at as createdAt, updated_at as updatedAt
     FROM users ORDER BY created_at DESC`,
  );
  return ctx.json({ users });
});

apiRouter.post("/users", async (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const payload = userSchema.parse(await ctx.req.json());
  const now = new Date().toISOString();
  const user: User = {
    id: createId("user"),
    email: payload.email.toLowerCase(),
    name: payload.name,
    avatarUrl: payload.avatarUrl || null,
    role: payload.role,
    status: payload.status,
    createdAt: now,
    updatedAt: now,
  };
  run(
    `INSERT INTO users (id, email, name, avatar_url, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.name, user.avatarUrl, user.role, user.status, now, now],
  );
  return ctx.json({ user });
});

apiRouter.patch("/users/:userId", async (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const payload = userSchema.partial().parse(await ctx.req.json());
  const userId = ctx.req.param("userId");
  const existing = one<User>(
    `SELECT id, email, name, avatar_url as avatarUrl, role, status, created_at as createdAt, updated_at as updatedAt
     FROM users WHERE id = ?`,
    [userId],
  );
  if (!existing) {
    throw new HttpError(404, "User not found");
  }

  const updated = { ...existing, ...payload, avatarUrl: payload.avatarUrl === "" ? null : payload.avatarUrl ?? existing.avatarUrl, updatedAt: new Date().toISOString() };
  run(
    `UPDATE users SET name = ?, avatar_url = ?, role = ?, status = ?, updated_at = ? WHERE id = ?`,
    [updated.name, updated.avatarUrl, updated.role, updated.status, updated.updatedAt, userId],
  );
  return ctx.json({ user: updated });
});

apiRouter.delete("/users/:userId", async (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  await clearUserSessions(ctx.req.param("userId"));
  run("DELETE FROM project_memberships WHERE user_id = ?", [ctx.req.param("userId")]);
  run("DELETE FROM users WHERE id = ?", [ctx.req.param("userId")]);
  return ctx.json({ success: true });
});

apiRouter.get("/projects", (ctx) => {
  const auth = requireAuth(ctx);
  const seeAll = auth.user.role === "admin" || auth.user.role === "viewer";
  return ctx.json({ projects: mapProjectRows(auth.user.id, seeAll) });
});

apiRouter.post("/projects", async (ctx) => {
  const auth = requireWorkspaceRole(ctx, ["admin"]);
  const payload = projectSchema.parse(await ctx.req.json());
  const now = new Date().toISOString();
  const projectId = createId("project");
  run(
    `INSERT INTO projects (id, name, slug, sentry_project_id, environment, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, payload.name, payload.slug, nextSentryProjectId(), payload.environment, payload.active ? 1 : 0, now, now],
  );

  const publicKey = randomToken(12);
  const secretKey = randomToken(24);
  const sentryProjectId = one<{ sentryProjectId: string }>(
    "SELECT sentry_project_id as sentryProjectId FROM projects WHERE id = ?",
    [projectId],
  )?.sentryProjectId;
  const dsn = buildProjectDsn(publicKey, sentryProjectId!);
  run(
    `INSERT INTO project_keys (id, project_id, public_key, secret_key, dsn, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [createId("pkey"), projectId, publicKey, secretKey, dsn, now],
  );
  run(
    `INSERT OR IGNORE INTO project_memberships (user_id, project_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
    [auth.user.id, projectId, "manager", now],
  );

  const project = mapProjectRows(auth.user.id, true).find((entry) => entry.id === projectId);
  return ctx.json({ project });
});

apiRouter.patch("/projects/:projectId", async (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const payload = projectSchema.partial().parse(await ctx.req.json());
  const projectId = ctx.req.param("projectId");
  const existing = one<Project>(
    `SELECT id, name, slug, environment, active, created_at as createdAt, updated_at as updatedAt FROM projects WHERE id = ?`,
    [projectId],
  );
  if (!existing) {
    throw new HttpError(404, "Project not found");
  }

  run(
    `UPDATE projects SET name = ?, slug = ?, environment = ?, active = ?, updated_at = ? WHERE id = ?`,
    [
      payload.name ?? existing.name,
      payload.slug ?? existing.slug,
      payload.environment ?? existing.environment,
      typeof payload.active === "boolean" ? (payload.active ? 1 : 0) : existing.active ? 1 : 0,
      new Date().toISOString(),
      projectId,
    ],
  );

  const auth = requireAuth(ctx);
  const project = mapProjectRows(auth.user.id, true).find((entry) => entry.id === projectId);
  return ctx.json({ project });
});

apiRouter.delete("/projects/:projectId", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const projectId = ctx.req.param("projectId");
  run("DELETE FROM project_memberships WHERE project_id = ?", [projectId]);
  run("DELETE FROM project_keys WHERE project_id = ?", [projectId]);
  run("DELETE FROM projects WHERE id = ?", [projectId]);
  return ctx.json({ success: true });
});

apiRouter.get("/projects/:projectId/members", (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, false);
  const memberships = all<ProjectMembership>(
    `SELECT user_id as userId, project_id as projectId, role, created_at as createdAt
     FROM project_memberships WHERE project_id = ? ORDER BY created_at DESC`,
    [projectId],
  );
  return ctx.json({ memberships });
});

apiRouter.put("/projects/:projectId/members/:userId", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);
  const userId = ctx.req.param("userId");
  const payload = membershipSchema.parse(await ctx.req.json());
  run(
    `INSERT INTO project_memberships (user_id, project_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role`,
    [userId, projectId, payload.role, new Date().toISOString()],
  );
  return ctx.json({ success: true });
});

apiRouter.delete("/projects/:projectId/members/:userId", (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);
  run("DELETE FROM project_memberships WHERE user_id = ? AND project_id = ?", [
    ctx.req.param("userId"),
    projectId,
  ]);
  return ctx.json({ success: true });
});

apiRouter.get("/dashboard/summary", async (ctx) => {
  const auth = requireAuth(ctx);
  const seeAll = auth.user.role === "admin" || auth.user.role === "viewer";
  const projects = mapProjectRows(auth.user.id, seeAll).map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    environment: project.environment,
    active: project.active,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }));
  const cards = await dashboardCards(
    projects.map((project) => project.id),
    projects,
  );
  return ctx.json({ cards });
});

apiRouter.get("/settings/server", (ctx) => {
  requireWorkspaceRole(ctx, ["admin", "viewer"]);
  const settings: ServerSettings = getServerSettings();
  return ctx.json({ settings });
});

apiRouter.post("/settings/server/regenerate-token", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const settings: ServerSettings = {
    ...getServerSettings(),
    ekeeperAuthToken: regenerateServerAuthToken(),
  };
  return ctx.json({ settings });
});

apiRouter.get("/minimaps", (ctx) => {
  requireWorkspaceRole(ctx, ["admin", "viewer"]);
  const projectId = ctx.req.query("projectId") ?? undefined;
  const artifacts = listMinimapArtifacts(projectId);
  const olderThanThirtyDays = artifacts.filter(
    (artifact) => new Date(artifact.uploadedAt).getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).length;
  return ctx.json({ artifacts, olderThanThirtyDays });
});

apiRouter.post("/minimaps/upload", async (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const formData = await ctx.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "A source map file is required");
  }

  const payload = minimapUploadSchema.parse({
    org: String(formData.get("org") ?? config.EKEEPER_ORG),
    projectId: String(formData.get("projectId") ?? ""),
    release: String(formData.get("release") ?? ""),
    dist: formData.get("dist") ? String(formData.get("dist")) : null,
    artifactName: String(formData.get("artifactName") ?? file.name),
  });
  const project = one<{ id: string; slug: string }>(
    "SELECT id, slug FROM projects WHERE id = ?",
    [payload.projectId],
  );
  if (!project) {
    throw new HttpError(400, "Project not found");
  }

  const artifact = saveMinimapArtifact({
    ...payload,
    project: project.slug,
    contentType: file.type || null,
    buffer: new Uint8Array(await file.arrayBuffer()),
  });

  return ctx.json({ artifact });
});

apiRouter.post("/minimaps/cleanup-old", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  const result = cleanupExpiredMinimaps();
  return ctx.json(result);
});

apiRouter.get("/projects/all/errors", async (ctx) => {
  const auth = requireAuth(ctx);
  const seeAllProjects = auth.user.role === "admin" || auth.user.role === "viewer";
  const projectIds = seeAllProjects
    ? all<{ id: string }>("SELECT id FROM projects").map((project) => project.id)
    : auth.memberships.map((membership) => membership.projectId);
  const errors = filterErrors(await queryErrorGroups(projectIds), {
    state: ctx.req.query("state") ?? "open_or_reopened",
    assignment: ctx.req.query("assignment") ?? "any",
    assignedUserId: ctx.req.query("assignedUserId") ?? undefined,
  });
  return ctx.json({ errors });
});

apiRouter.get("/projects/:projectId/errors", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, false);
  const errors = filterErrors(await queryErrorGroups([projectId]), {
    state: ctx.req.query("state") ?? "open_or_reopened",
    assignment: ctx.req.query("assignment") ?? "any",
    assignedUserId: ctx.req.query("assignedUserId") ?? undefined,
  });
  return ctx.json({ errors });
});

apiRouter.get("/error-assignees", (ctx) => {
  const auth = requireAuth(ctx);
  const requestedProjectId = ctx.req.query("projectId");
  const visibleProjectIds =
    requestedProjectId
      ? [requestedProjectId]
      : (auth.user.role === "admin" || auth.user.role === "viewer")
        ? all<{ id: string }>("SELECT id FROM projects").map((project) => project.id)
        : auth.memberships.map((membership) => membership.projectId);

  if (requestedProjectId) {
    requireProjectAccess(ctx, requestedProjectId, false);
  }

  if (visibleProjectIds.length === 0) {
    return ctx.json({ users: [] });
  }

  const users = all<Pick<User, "id" | "name" | "email" | "avatarUrl" | "role" | "status" | "createdAt" | "updatedAt">>(
    `
      SELECT DISTINCT u.id, u.name, u.email, u.avatar_url as avatarUrl, u.role, u.status,
        u.created_at as createdAt, u.updated_at as updatedAt
      FROM users u
      INNER JOIN project_memberships pm ON pm.user_id = u.id
      WHERE pm.project_id IN (${visibleProjectIds.map(() => "?").join(", ")})
      ORDER BY u.name ASC
    `,
    visibleProjectIds,
  );
  return ctx.json({ users });
});

apiRouter.get("/projects/:projectId/errors/:groupId", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  const groupId = ctx.req.param("groupId");
  requireProjectAccess(ctx, projectId, false);
  const client = getClickHouseClient();
  const eventIdParam = ctx.req.query("eventId");

  // Fetch all occurrence summaries (eventId + timestamp) for navigation
  const occurrenceResult = await client.query({
    query: `
      SELECT event_id AS eventId, timestamp
      FROM events
      WHERE project_id = {projectId:String} AND group_id = {groupId:String}
      ORDER BY timestamp DESC
    `,
    query_params: { projectId, groupId },
    format: "JSONEachRow",
  });
  const occurrences = (await occurrenceResult.json()) as Array<{ eventId: string; timestamp: string }>;

  // Fetch the requested event (by eventId) or the latest one
  const eventQuery = eventIdParam
    ? `
      SELECT event_id AS eventId, group_id AS groupId, message, exception, stacktrace,
        browser, device, os, runtime, tags, contexts, raw_payload AS rawPayload, timestamp
      FROM events
      WHERE project_id = {projectId:String} AND group_id = {groupId:String} AND event_id = {eventId:String}
      LIMIT 1
    `
    : `
      SELECT event_id AS eventId, group_id AS groupId, message, exception, stacktrace,
        browser, device, os, runtime, tags, contexts, raw_payload AS rawPayload, timestamp
      FROM events
      WHERE project_id = {projectId:String} AND group_id = {groupId:String}
      ORDER BY timestamp DESC
      LIMIT 1
    `;
  const eventResult = await client.query({
    query: eventQuery,
    query_params: { projectId, groupId, eventId: eventIdParam ?? "" },
    format: "JSONEachRow",
  });
  const events = (await eventResult.json()) as Array<Omit<ErrorEventDetail, "breadcrumbs">>;

  const latestEvent = events[0];

  // Fetch breadcrumbs scoped to the specific event
  const breadcrumbResult = await client.query({
    query: `
      SELECT timestamp, category, level, message, type, data
      FROM breadcrumbs
      WHERE project_id = {projectId:String} AND group_id = {groupId:String}
        AND event_id = {eventId:String}
      ORDER BY timestamp DESC
      LIMIT 100
    `,
    query_params: { projectId, groupId, eventId: latestEvent?.eventId ?? "" },
    format: "JSONEachRow",
  });

  const breadcrumbs = (await breadcrumbResult.json()) as ErrorEventDetail["breadcrumbs"];
  const workflow = one<{
    state: IssueState;
    assignedUserId: string | null;
    assignedUserName: string | null;
  }>(
    `
      SELECT iw.state as state, iw.assigned_user_id as assignedUserId, u.name as assignedUserName
      FROM issue_workflows iw
      LEFT JOIN users u ON u.id = iw.assigned_user_id
      WHERE iw.project_id = ? AND iw.group_id = ?
    `,
    [projectId, groupId],
  );
  const deobfuscated = latestEvent
    ? deobfuscateEvent({
        projectId,
        rawPayload: latestEvent.rawPayload,
        stacktrace: latestEvent.stacktrace,
        exception: latestEvent.exception,
      })
    : null;
  const error = latestEvent
    ? {
        ...latestEvent,
        projectId,
        breadcrumbs,
        stacktrace: deobfuscated?.stacktrace ?? latestEvent.stacktrace,
        exception: deobfuscated?.exception ?? latestEvent.exception,
        state: workflow?.state ?? "open",
        assignedUserId: workflow?.assignedUserId ?? null,
        assignedUserName: workflow?.assignedUserName ?? null,
        sourceMapApplied: deobfuscated?.applied ?? false,
        sourceMapRelease: deobfuscated?.release ?? null,
      }
    : null;
  return ctx.json({ error, occurrences });
});

apiRouter.patch("/projects/:projectId/errors/:groupId/workflow", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  const groupId = ctx.req.param("groupId");
  requireProjectAccess(ctx, projectId, true);
  const payload = workflowSchema.parse(await ctx.req.json());

  if (payload.assignedUserId) {
    const member = one<{ userId: string }>(
      "SELECT user_id as userId FROM project_memberships WHERE project_id = ? AND user_id = ?",
      [projectId, payload.assignedUserId],
    );
    if (!member) {
      throw new HttpError(400, "Assigned user must be a member of this project");
    }
  }

  upsertIssueWorkflow(projectId, groupId, {
    state: payload.state,
    assignedUserId: payload.assignedUserId,
  });

  const errors = await queryErrorGroups([projectId]);
  const issue = errors.find((entry) => entry.groupId === groupId);
  return ctx.json({ issue });
});
