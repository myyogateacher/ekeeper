import { TupleParam } from "@clickhouse/client";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config";
import { getClickHouseClient } from "../db/clickhouse";
import { all, one, run } from "../db/sqlite";
import { clearUserSessions, requireAuth, requireProjectAccess, requireWorkspaceRole } from "../lib/auth";
import { HttpError } from "../lib/http";
import { createId, randomToken } from "../lib/ids";
import { normalizeExceptionValue } from "../lib/ingest";
import {
  cleanupExpiredMinimapsAsync,
  countExpiredMinimaps,
  deobfuscateEvent,
  getLatestReleaseMapCount,
  isMinimapCleanupRunning,
  listMinimapArtifacts,
  saveMinimapArtifact,
} from "../lib/minimaps";
import { getMcpSecretKey, getServerAuthToken, getServerSettings, regenerateMcpSecretKey, regenerateServerAuthToken } from "../lib/server-settings";
import {
  cleanupDuplicateGithubIssues,
  ensureGithubIssueForGroup,
  getGithubIntegration,
  getGithubLink,
  getGithubLinksForProjects,
  parseLabels,
  syncGithubIssueState,
} from "../lib/issue-sync";
import { EVENTS_24H_SQL, EVENTS_7D_SQL, buildEventNavigation, buildIssueStats, hourlyColumnsSql, isoFromEpochMs, type NavigationRow, type StatsRow } from "../lib/issue-stats";
import { upsertIssueWorkflow } from "../lib/issue-workflow";
import type {
  AffectedUsersResponse,
  DashboardProjectCard,
  DuplicateIssueGroup,
  ErrorDetailResponse,
  ErrorEventDetail,
  ErrorGroupSummary,
  EventNavigation,
  IngestStatus,
  IssueState,
  IssueStats,
  MinimapArtifact,
  Project,
  ProjectGithubIntegration,
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

const githubIntegrationSchema = z.object({
  owner: z.string().min(1).max(120),
  repo: z.string().min(1).max(120),
  defaultLabels: z.array(z.string().min(1).max(60)).max(20).default([]),
  webhookSecret: z.string().min(1).max(200).nullable().optional(),
  personalAccessToken: z.string().min(1).max(500).nullable().optional(),
});

const minimapUploadSchema = z.object({
  org: z.string().min(1).default(config.EKEEPER_ORG),
  projectId: z.string().min(1),
  release: z.string().min(1),
  dist: z.string().min(1).nullable().optional(),
  artifactName: z.string().min(1),
});

// The issues list shows at most this many rows (ISSUE_LIST_MAX_ROWS in frontend/src/lib/issue-list.ts), and the
// header total covers the rows on screen, so a request never needs more. It is also the bound on the tuple set
// handed to ClickHouse as one query parameter, which travels in the URL. The id caps are generous on purpose:
// events.group_id is unbounded for an explicit fingerprint stored before PROD-10529, and a cap that rejected a
// real group would fail the whole header, but a bounded body keeps one request from carrying megabytes.
const AFFECTED_USERS_MAX_GROUPS = 500;
const affectedUsersSchema = z.object({
  groups: z
    .array(z.object({ projectId: z.string().min(1).max(128), groupId: z.string().min(1).max(4096) }))
    .max(AFFECTED_USERS_MAX_GROUPS),
});

// One definition of "users affected" for every screen that shows it: the issues list, its header total, the
// issue page and the similar issues rows must agree for the same group, and a user who sent no id (user_id is
// '' in events) is not a user. Interpolated into SQL as a constant, never built from input.
const AFFECTED_USERS_SQL = "uniqIf(user_id, user_id != '')";

/**
 * Distinct users over the union of the given groups, all time. One user hitting two groups counts once, so this
 * is the only correct way to total several groups (summing per group counts overcounts). The tuple IN is a
 * constant set, so ClickHouse prunes by the sort key (project_id, group_id, ...) and reads only these groups'
 * rows and only user_id; a set built by a subquery over arrayZip was measured to skip that pruning and read
 * every granule. The issue page passes one group, the list header up to 500.
 */
export async function queryAffectedUsers(groups: Array<{ projectId: string; groupId: string }>): Promise<number> {
  if (groups.length === 0) {
    return 0;
  }

  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT ${AFFECTED_USERS_SQL} AS affectedUsers
      FROM events
      WHERE (project_id, group_id) IN {groups:Array(Tuple(String, String))}
    `,
    query_params: { groups: groups.map(({ projectId, groupId }) => new TupleParam([projectId, groupId])) },
    format: "JSONEachRow",
  });
  const [row] = (await result.json()) as Array<{ affectedUsers: string | number }>;
  return Number(row?.affectedUsers ?? 0);
}

/**
 * Whole-group figures for the issue page in one read of the group's rows (the sort key prefix project_id,
 * group_id). Nothing here returns a row per event, which the detail endpoint used to do for every occurrence of
 * the group on every load and every switch between events. One query, so one `now()` for the 24h and 7d counts and
 * for all 24 hourly buckets (see issue-stats.ts for why that makes the chart sum to events24h). The aliases are
 * not column names (defect register 20).
 */
export async function queryGroupStats(projectId: string, groupId: string): Promise<IssueStats> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        count() AS totalEvents,
        ${EVENTS_24H_SQL} AS events24h,
        ${EVENTS_7D_SQL} AS events7d,
        toUnixTimestamp64Milli(min(timestamp)) AS firstSeenMs,
        toUnixTimestamp64Milli(max(timestamp)) AS lastSeenMs,
        ${hourlyColumnsSql()}
      FROM events
      WHERE project_id = {projectId:String} AND group_id = {groupId:String}
    `,
    query_params: { projectId, groupId },
    format: "JSONEachRow",
  });
  // An aggregate with no GROUP BY returns exactly one row, with zeros, for a group that has no events.
  const [row] = (await result.json()) as StatsRow[];
  return buildIssueStats(row!);
}

/**
 * Where one event sits in its group, newest first, in one aggregate over the group's rows. Events order by
 * (timestamp, event_id), the table's sort key order, so two events in the same millisecond still have a defined
 * neighbour and position; the detail route's own "latest event" read uses the same order. Reads timestamp and
 * event_id only. `current` is the shown event as read from this table, which is why it is always in the group.
 */
export async function queryEventNavigation(
  projectId: string,
  groupId: string,
  current: { eventId: string; timestamp: string },
): Promise<EventNavigation> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        count() AS totalEvents,
        countIf((timestamp, event_id) > ({currentAt:DateTime64(3, 'UTC')}, {currentEventId:String})) AS newerCount,
        countIf((timestamp, event_id) < ({currentAt:DateTime64(3, 'UTC')}, {currentEventId:String})) AS olderCount,
        argMax(event_id, (timestamp, event_id)) AS latestEventId,
        argMin(event_id, (timestamp, event_id)) AS oldestEventId,
        argMinIf(event_id, (timestamp, event_id), (timestamp, event_id) > ({currentAt:DateTime64(3, 'UTC')}, {currentEventId:String})) AS newerEventId,
        argMaxIf(event_id, (timestamp, event_id), (timestamp, event_id) < ({currentAt:DateTime64(3, 'UTC')}, {currentEventId:String})) AS olderEventId
      FROM events
      WHERE project_id = {projectId:String} AND group_id = {groupId:String}
    `,
    query_params: { projectId, groupId, currentAt: current.timestamp, currentEventId: current.eventId },
    format: "JSONEachRow",
  });
  const [row] = (await result.json()) as NavigationRow[];
  return buildEventNavigation(row!);
}

/**
 * The newest event time of a project as ISO 8601 UTC with Z, or null when it has none. The sort key leads with
 * project_id but timestamp is its third column, so this is not a read of one row: ClickHouse reads this project's
 * timestamp column and nothing else. That is one 8 byte column over one project, against 196,902 events across
 * every project in 120 days, and the Settings screen asks when a person opens it, so it was not worth a second
 * table; if a screen ever polls this, read project_daily_metrics for the day first.
 */
export async function queryLastEventAt(projectId: string): Promise<string | null> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT count() AS eventCount, toUnixTimestamp64Milli(max(timestamp)) AS lastEventMs
      FROM events
      WHERE project_id = {projectId:String}
    `,
    query_params: { projectId },
    format: "JSONEachRow",
  });
  const [row] = (await result.json()) as Array<{ eventCount: string | number; lastEventMs: string | number }>;
  // max over no rows is the type's default, 1970-01-01, so the count decides whether there is a time at all.
  return Number(row?.eventCount ?? 0) > 0 ? isoFromEpochMs(row!.lastEventMs) : null;
}

const DUPLICATE_URL_PATTERN = /https?:\/\/[^\s"'<>\\)]+/;
const DUPLICATE_UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

function normalizeDuplicateMessageKey(message: string): string {
  return normalizeExceptionValue(message)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function duplicateMessageSearchPattern(message: string): string {
  const urlIndex = message.search(DUPLICATE_URL_PATTERN);
  if (urlIndex > -1) {
    return `${message.slice(0, urlIndex)}%`;
  }

  const uuidIndex = message.search(DUPLICATE_UUID_PATTERN);
  if (uuidIndex > 8) {
    return `${message.slice(0, uuidIndex)}%`;
  }

  return message;
}

// Exported for api-clickhouse.test.ts. The issue detail route reaches it through safeQueryDuplicateIssueGroups,
// which turns a failed query into an empty list, so the test calls this one to see a failure.
export async function queryDuplicateIssueGroups(
  projectId: string,
  groupId: string,
  message: string,
): Promise<DuplicateIssueGroup[]> {
  const key = normalizeDuplicateMessageKey(message);
  if (!key) {
    return [];
  }

  // No alias below is also a column of `events`. ClickHouse resolves a name in WHERE to a SELECT alias before a
  // column when prefer_column_name_to_alias is 0 (the 24.8 default), so the first version's
  // `any(message) AS message` made `WHERE message = ...` read an aggregate and fail with ILLEGAL_AGGREGATION
  // (PROD-10527, defect register 20). Which way that setting is set depends on the server profile and
  // version, so the query must not depend on it; the sample* names are mapped back to the response keys below.
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        group_id AS groupId,
        any(title) AS sampleTitle,
        any(message) AS sampleMessage,
        any(fingerprint) AS sampleFingerprint,
        count() AS eventCount,
        ${AFFECTED_USERS_SQL} AS affectedUsers,
        min(timestamp) AS firstSeen,
        max(timestamp) AS lastSeen,
        argMax(release, timestamp) AS latestRelease
      FROM events
      WHERE project_id = {projectId:String}
        AND group_id != {groupId:String}
        AND timestamp >= now() - INTERVAL 90 DAY
        AND (message = {message:String} OR message LIKE {messagePattern:String})
      GROUP BY group_id
      ORDER BY eventCount DESC, lastSeen DESC
      LIMIT 50
    `,
    query_params: {
      projectId,
      groupId,
      message,
      messagePattern: duplicateMessageSearchPattern(message),
    },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{
    groupId: string;
    sampleTitle: string;
    sampleMessage: string;
    sampleFingerprint: string;
    eventCount: string | number;
    affectedUsers: string | number;
    firstSeen: string;
    lastSeen: string;
    latestRelease: string;
  }>;

  return rows
    .filter((row) => normalizeDuplicateMessageKey(row.sampleMessage) === key)
    .slice(0, 12)
    .map((row) => ({
      groupId: row.groupId,
      title: row.sampleTitle,
      message: row.sampleMessage,
      fingerprint: row.sampleFingerprint,
      events: Number(row.eventCount),
      affectedUsers: Number(row.affectedUsers),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      // events.release is '' for an event with no release, never NULL, so `?? null` left an empty string.
      latestRelease: row.latestRelease || null,
    }));
}

async function safeQueryDuplicateIssueGroups(
  projectId: string,
  groupId: string,
  message: string,
): Promise<DuplicateIssueGroup[]> {
  try {
    return await queryDuplicateIssueGroups(projectId, groupId, message);
  } catch (error) {
    console.warn("Failed to query duplicate issue groups", { projectId, groupId, error });
    return [];
  }
}

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

  // Exclude closed issues from the group count so it drops on closure
  const closedGroupKeys = all<{ key: string }>(
    `SELECT project_id || ':' || group_id AS key
     FROM issue_workflows
     WHERE state = 'closed' AND project_id IN (${projectIds.map(() => "?").join(", ")})`,
    projectIds,
  ).map((row) => row.key);

  const client = getClickHouseClient();
  const filter = projectIds.map((id) => `'${id}'`).join(", ");
  const recurringGroups = closedGroupKeys.length
    ? "uniqIf(group_id, concat(project_id, ':', group_id) NOT IN {closedGroupKeys:Array(String)})"
    : "uniq(group_id)";
  const result = await client.query({
    query: `
      SELECT
        project_id AS projectId,
        count() AS totalEvents7d,
        ${recurringGroups} AS recurringGroups7d,
        uniqIf(user_id, user_id != '') AS impactedUsers7d,
        any(title) AS topGroupTitle
      FROM events
      WHERE project_id IN (${filter}) AND timestamp >= now() - INTERVAL 7 DAY
      GROUP BY project_id
    `,
    query_params: closedGroupKeys.length ? { closedGroupKeys } : undefined,
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

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes an ISO date/datetime query param into a ClickHouse-friendly UTC datetime string.
 * Invalid values are ignored (returns undefined) so a bad param never breaks the listing.
 * Date-only values snap to the start (`from`) or end (`to`) of that UTC day.
 */
function parseDateBoundary(value: string | undefined, edge: "from" | "to"): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = DATE_ONLY_PATTERN.test(trimmed)
    ? `${trimmed}T${edge === "from" ? "00:00:00.000Z" : "23:59:59.999Z"}`
    : trimmed;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

async function queryErrorGroups(
  projectIds: string[],
  options: { user?: string; from?: string; to?: string } = {},
): Promise<ErrorGroupSummary[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const client = getClickHouseClient();
  const filter = projectIds.map((id) => `'${id}'`).join(", ");
  const userTerm = options.user?.trim();
  const fromTs = parseDateBoundary(options.from, "from");
  const toTs = parseDateBoundary(options.to, "to");

  // Range filters apply to the group's last-seen timestamp: "issues seen within this window".
  const havingConditions: string[] = [];
  const queryParams: Record<string, string> = {};
  if (userTerm) {
    havingConditions.push(
      "countIf(user_id = {userTerm:String} OR user_email = {userTerm:String} OR user_username = {userTerm:String}) > 0",
    );
    queryParams.userTerm = userTerm;
  }
  if (fromTs) {
    havingConditions.push("max(timestamp) >= parseDateTimeBestEffort({fromTs:String})");
    queryParams.fromTs = fromTs;
  }
  if (toTs) {
    havingConditions.push("max(timestamp) <= parseDateTimeBestEffort({toTs:String})");
    queryParams.toTs = toTs;
  }
  const userFilter = havingConditions.length ? `HAVING ${havingConditions.join(" AND ")}` : "";

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
        ${AFFECTED_USERS_SQL} AS affectedUsers
      FROM events
      WHERE project_id IN (${filter})
      GROUP BY project_id, group_id
      ${userFilter}
      ORDER BY count7d DESC, lastSeen DESC
    `,
    query_params: Object.keys(queryParams).length ? queryParams : undefined,
    format: "JSONEachRow",
  });

  const rows = (await result.json()) as Array<
    Omit<ErrorGroupSummary, "state" | "assignedUserId" | "assignedUserName" | "githubIssueNumber" | "githubIssueUrl">
  >;
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

  const githubLinks = getGithubLinksForProjects(projectIds);
  const githubByKey = new Map(
    githubLinks.map((row) => [`${row.projectId}:${row.groupId}`, row]),
  );

  return rows.map((row) => {
    const key = `${row.projectId}:${row.groupId}`;
    const workflow = workflowByKey.get(key);
    const link = githubByKey.get(key);
    return {
    ...row,
    count7d: Number(row.count7d),
    count24h: Number(row.count24h),
    affectedUsers: Number(row.affectedUsers),
      state: workflow?.state ?? "open",
      assignedUserId: workflow?.assignedUserId ?? null,
      assignedUserName: workflow?.assignedUserName ?? null,
      githubIssueNumber: link?.githubIssueNumber ?? null,
      githubIssueUrl: link?.githubIssueUrl ?? null,
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

const ERRORS_DEFAULT_LIMIT = 25;
const ERRORS_MAX_LIMIT = 100;

function parseErrorPagination(limitParam?: string, offsetParam?: string) {
  const parsedLimit = Number.parseInt(limitParam ?? "", 10);
  const parsedOffset = Number.parseInt(offsetParam ?? "", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, ERRORS_MAX_LIMIT)
    : ERRORS_DEFAULT_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  return { limit, offset };
}

function paginateErrors(errors: ErrorGroupSummary[], limit: number, offset: number) {
  return {
    errors: errors.slice(offset, offset + limit),
    total: errors.length,
    limit,
    offset,
  };
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

// Display-safe settings (org, URL, minimap retention) — no secrets, so any
// signed-in role may read them.
apiRouter.get("/settings/server", (ctx) => {
  requireAuth(ctx);
  const settings: ServerSettings = getServerSettings();
  return ctx.json({ settings });
});

// The upload token doubles as the bearer credential for plugin artifact
// uploads (/api/0), so only admins may read or rotate it.
apiRouter.get("/settings/server/token", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  return ctx.json({ token: getServerAuthToken() });
});

apiRouter.post("/settings/server/regenerate-token", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  return ctx.json({ token: regenerateServerAuthToken() });
});

// The MCP secret key is viewable by any signed-in user; rotation is admin-only.
apiRouter.get("/settings/mcp-key", (ctx) => {
  requireAuth(ctx);
  return ctx.json({ key: getMcpSecretKey() });
});

apiRouter.post("/settings/mcp-key/regenerate", (ctx) => {
  requireWorkspaceRole(ctx, ["admin"]);
  return ctx.json({ key: regenerateMcpSecretKey() });
});

apiRouter.get("/minimaps", (ctx) => {
  requireWorkspaceRole(ctx, ["admin", "viewer"]);
  const projectId = ctx.req.query("projectId") ?? undefined;
  return ctx.json(
    listMinimapArtifacts(projectId, {
      limit: Number(ctx.req.query("limit")),
      offset: Number(ctx.req.query("offset")),
    }),
  );
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
  // Optional scope: without it the run covers every project, like the daily scheduler.
  const projectId = ctx.req.query("projectId") ?? undefined;
  const eligible = countExpiredMinimaps(projectId);
  if (isMinimapCleanupRunning()) {
    return ctx.json({ started: false, eligible }, 202);
  }

  // Fire and forget: deletion continues in the background so the request returns immediately.
  void cleanupExpiredMinimapsAsync(projectId).catch((error) => {
    console.error("[minimaps] async cleanup failed", error);
  });
  return ctx.json({ started: true, eligible }, 202);
});

// Distinct users over the union of the given groups, for the issues list header. Not a GET: the set is up to 500
// (project, group) pairs, too much for a query string. Every project named must pass the same read check the
// detail route applies, and the check runs before any query, so a project the caller cannot read is never counted
// and the answer cannot reveal how many users it has.
apiRouter.post("/errors/affected-users", async (ctx) => {
  requireAuth(ctx);
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  const parsed = affectedUsersSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Invalid request: ${issue?.path.join(".") || "body"}: ${issue?.message}`);
  }

  const { groups } = parsed.data;
  for (const projectId of new Set(groups.map((group) => group.projectId))) {
    requireProjectAccess(ctx, projectId, false);
  }
  return ctx.json({ affectedUsers: await queryAffectedUsers(groups) } satisfies AffectedUsersResponse);
});

// The Settings "Connect an app" verify line. Same access as the Projects section, which lists the projects
// GET /projects returns: admin and workspace viewer read any project, a manager only their memberships.
apiRouter.get("/projects/:projectId/ingest-status", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, false);
  const sourceMaps = getLatestReleaseMapCount(projectId);
  const lastEventAt = await queryLastEventAt(projectId);
  return ctx.json({
    lastEventAt,
    latestRelease: sourceMaps.release,
    sourceMapFiles: sourceMaps.mapFiles,
  } satisfies IngestStatus);
});

apiRouter.get("/projects/all/errors", async (ctx) => {
  const auth = requireAuth(ctx);
  const seeAllProjects = auth.user.role === "admin" || auth.user.role === "viewer";
  const projectIds = seeAllProjects
    ? all<{ id: string }>("SELECT id FROM projects").map((project) => project.id)
    : auth.memberships.map((membership) => membership.projectId);
  const errors = filterErrors(
    await queryErrorGroups(projectIds, {
      user: ctx.req.query("user") ?? undefined,
      from: ctx.req.query("from") ?? undefined,
      to: ctx.req.query("to") ?? undefined,
    }),
    {
      state: ctx.req.query("state") ?? "open_or_reopened",
      assignment: ctx.req.query("assignment") ?? "any",
      assignedUserId: ctx.req.query("assignedUserId") ?? undefined,
    },
  );
  const { limit, offset } = parseErrorPagination(ctx.req.query("limit"), ctx.req.query("offset"));
  return ctx.json(paginateErrors(errors, limit, offset));
});

apiRouter.get("/projects/:projectId/errors", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, false);
  const errors = filterErrors(
    await queryErrorGroups([projectId], {
      user: ctx.req.query("user") ?? undefined,
      from: ctx.req.query("from") ?? undefined,
      to: ctx.req.query("to") ?? undefined,
    }),
    {
      state: ctx.req.query("state") ?? "open_or_reopened",
      assignment: ctx.req.query("assignment") ?? "any",
      assignedUserId: ctx.req.query("assignedUserId") ?? undefined,
    },
  );
  const { limit, offset } = parseErrorPagination(ctx.req.query("limit"), ctx.req.query("offset"));
  return ctx.json(paginateErrors(errors, limit, offset));
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

// The columns the event read below selects, as ErrorEventDetail types them. Everything else on the response is
// added in the handler, and `satisfies ErrorEventDetail` there fails to compile when a field is missing.
type DetailEventRow = Pick<
  ErrorEventDetail,
  "eventId" | "groupId" | "message" | "exception" | "stacktrace" | "browser" | "device" | "os" | "runtime" | "tags" | "contexts" | "rawPayload" | "timestamp"
>;

apiRouter.get("/projects/:projectId/errors/:groupId", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  const groupId = ctx.req.param("groupId");
  requireProjectAccess(ctx, projectId, false);
  const client = getClickHouseClient();
  const eventIdParam = ctx.req.query("eventId");

  // The requested event (by eventId) or the latest one. The latest is picked by (timestamp, event_id) descending,
  // the same order queryEventNavigation numbers events in, so "latest" is never two different events when two
  // share a millisecond.
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
      ORDER BY timestamp DESC, event_id DESC
      LIMIT 1
    `;
  // The group's stats do not depend on which event is shown, so they run beside the event read.
  const [eventResult, stats] = await Promise.all([
    client.query({
      query: eventQuery,
      query_params: { projectId, groupId, eventId: eventIdParam ?? "" },
      format: "JSONEachRow",
    }),
    queryGroupStats(projectId, groupId),
  ]);
  const events = (await eventResult.json()) as DetailEventRow[];

  const latestEvent = events[0];

  // Everything below needs the event: its breadcrumbs, its place in the group, the group's users, and the other
  // groups with its message. They are independent reads, so they run together; a failure in any of the first three
  // is a 500 like the event read, the similar issues read degrades to [] (safeQueryDuplicateIssueGroups).
  const [breadcrumbs, navigation, affectedUsers, duplicateGroups] = latestEvent
    ? await Promise.all([
        client
          .query({
            query: `
              SELECT timestamp, category, level, message, type, data
              FROM breadcrumbs
              WHERE project_id = {projectId:String} AND group_id = {groupId:String}
                AND event_id = {eventId:String}
              ORDER BY timestamp DESC
              LIMIT 100
            `,
            query_params: { projectId, groupId, eventId: latestEvent.eventId },
            format: "JSONEachRow",
          })
          .then((result) => result.json() as Promise<ErrorEventDetail["breadcrumbs"]>),
        queryEventNavigation(projectId, groupId, latestEvent),
        queryAffectedUsers([{ projectId, groupId }]),
        safeQueryDuplicateIssueGroups(projectId, groupId, latestEvent.message),
      ])
    : [[], null, 0, []];

  const workflow = one<{
    state: IssueState;
    assignedUserId: string | null;
    assignedUserName: string | null;
    closedAt: string | null;
  }>(
    `
      SELECT iw.state as state, iw.assigned_user_id as assignedUserId, u.name as assignedUserName,
        iw.closed_at as closedAt
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
  const githubLink = getGithubLink(projectId, groupId);
  const error = latestEvent
    ? ({
        ...latestEvent,
        projectId,
        breadcrumbs,
        stacktrace: deobfuscated?.stacktrace ?? latestEvent.stacktrace,
        exception: deobfuscated?.exception ?? latestEvent.exception,
        state: workflow?.state ?? "open",
        assignedUserId: workflow?.assignedUserId ?? null,
        assignedUserName: workflow?.assignedUserName ?? null,
        // closed_at holds a value only while the state is closed: upsertIssueWorkflow writes null for any other
        // state, and the reopen on a new event in ingest-buffer.ts clears it.
        closedAt: workflow?.closedAt ?? null,
        sourceMapApplied: deobfuscated?.applied ?? false,
        sourceMapRelease: deobfuscated?.release ?? null,
        githubIssueNumber: githubLink?.githubIssueNumber ?? null,
        githubIssueUrl: githubLink?.githubIssueUrl ?? null,
        affectedUsers,
      } satisfies ErrorEventDetail)
    : null;
  return ctx.json({ error, stats, navigation, duplicateGroups } satisfies ErrorDetailResponse);
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

  if (payload.state) {
    await syncGithubIssueState({ projectId, groupId, ekeeperState: payload.state });
  }

  const errors = await queryErrorGroups([projectId]);
  const issue = errors.find((entry) => entry.groupId === groupId);
  return ctx.json({ issue });
});

function mapIntegrationRow(
  row: {
    projectId: string;
    owner: string;
    repo: string;
    defaultLabels: string;
    webhookSecret: string | null;
    personalAccessToken: string | null;
    createdAt: string;
    updatedAt: string;
  } | null,
): ProjectGithubIntegration | null {
  if (!row) {
    return null;
  }
  return {
    projectId: row.projectId,
    owner: row.owner,
    repo: row.repo,
    defaultLabels: parseLabels(row.defaultLabels),
    webhookSecretSet: Boolean(row.webhookSecret),
    personalAccessTokenSet: Boolean(row.personalAccessToken),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

apiRouter.get("/projects/:projectId/github-integration", (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, false);
  const row = one<{
    projectId: string;
    owner: string;
    repo: string;
    defaultLabels: string;
    webhookSecret: string | null;
    personalAccessToken: string | null;
    createdAt: string;
    updatedAt: string;
  }>(
    `SELECT project_id as projectId, owner, repo, default_labels as defaultLabels,
       webhook_secret as webhookSecret, personal_access_token as personalAccessToken,
       created_at as createdAt, updated_at as updatedAt
     FROM project_github_integrations WHERE project_id = ?`,
    [projectId],
  );
  return ctx.json({ integration: mapIntegrationRow(row) });
});

apiRouter.put("/projects/:projectId/github-integration", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);
  const payload = githubIntegrationSchema.parse(await ctx.req.json());
  const now = new Date().toISOString();
  const existing = getGithubIntegration(projectId);
  const createdAt =
    one<{ createdAt: string }>(
      "SELECT created_at as createdAt FROM project_github_integrations WHERE project_id = ?",
      [projectId],
    )?.createdAt ?? now;
  run(
    `INSERT INTO project_github_integrations
       (project_id, owner, repo, default_labels, webhook_secret, personal_access_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       owner = excluded.owner,
       repo = excluded.repo,
       default_labels = excluded.default_labels,
       webhook_secret = excluded.webhook_secret,
       personal_access_token = excluded.personal_access_token,
       updated_at = excluded.updated_at`,
    [
      projectId,
      payload.owner,
      payload.repo,
      JSON.stringify(payload.defaultLabels),
      payload.webhookSecret ?? existing?.webhookSecret ?? null,
      payload.personalAccessToken ?? existing?.personalAccessToken ?? null,
      createdAt,
      now,
    ],
  );

  const row = one<{
    projectId: string;
    owner: string;
    repo: string;
    defaultLabels: string;
    webhookSecret: string | null;
    personalAccessToken: string | null;
    createdAt: string;
    updatedAt: string;
  }>(
    `SELECT project_id as projectId, owner, repo, default_labels as defaultLabels,
       webhook_secret as webhookSecret, personal_access_token as personalAccessToken,
       created_at as createdAt, updated_at as updatedAt
     FROM project_github_integrations WHERE project_id = ?`,
    [projectId],
  );
  return ctx.json({ integration: mapIntegrationRow(row) });
});

apiRouter.delete("/projects/:projectId/github-integration", (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);
  run("DELETE FROM project_github_integrations WHERE project_id = ?", [projectId]);
  return ctx.json({ success: true });
});

apiRouter.post("/projects/:projectId/github-integration/backfill", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);

  const integration = getGithubIntegration(projectId);
  if (!integration) {
    throw new HttpError(400, "GitHub integration is not configured for this project");
  }

  const project = one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project not found");
  }

  const client = getClickHouseClient();
  const groupsResult = await client.query({
    query: `
      SELECT
        group_id AS groupId,
        argMin(title, timestamp) AS title,
        argMin(fingerprint, timestamp) AS fingerprint,
        argMin(message, timestamp) AS message,
        argMin(release, timestamp) AS release,
        argMin(exception, timestamp) AS exception,
        argMin(stacktrace, timestamp) AS stacktrace,
        argMin(raw_payload, timestamp) AS rawPayload,
        min(timestamp) AS firstSeen
      FROM events
      WHERE project_id = {projectId:String}
      GROUP BY group_id
      ORDER BY firstSeen ASC
    `,
    query_params: { projectId },
    format: "JSONEachRow",
  });
  const groups = (await groupsResult.json()) as Array<{
    groupId: string;
    title: string;
    fingerprint: string;
    message: string;
    release: string;
    exception: string;
    stacktrace: string;
    rawPayload: string;
    firstSeen: string;
  }>;

  const existingLinks = new Set(
    all<{ groupId: string }>(
      `SELECT group_id as groupId FROM error_group_github_issues WHERE project_id = ?`,
      [projectId],
    ).map((row) => row.groupId),
  );

  const unlinked = groups.filter((group) => !existingLinks.has(group.groupId));

  let created = 0;
  let failed = 0;
  for (const group of unlinked) {
    const exceptionType = (() => {
      try {
        const parsed = JSON.parse(group.exception ?? "{}");
        const values = Array.isArray(parsed?.values) ? parsed.values : [];
        const primary = values[0];
        return typeof primary?.type === "string" && primary.type.length > 0 ? primary.type : null;
      } catch {
        return null;
      }
    })();
    const link = await ensureGithubIssueForGroup({
      projectId,
      projectName: project.name,
      groupId: group.groupId,
      title: group.title,
      fingerprint: group.fingerprint,
      firstSeen: group.firstSeen,
      message: group.message ?? null,
      release: group.release && group.release.length > 0 ? group.release : null,
      exceptionType,
      stacktrace: group.stacktrace,
      exception: group.exception,
      rawPayload: group.rawPayload,
    });
    if (link) {
      created += 1;
    } else {
      failed += 1;
    }
  }

  return ctx.json({
    totalGroups: groups.length,
    alreadyLinked: groups.length - unlinked.length,
    candidatesProcessed: unlinked.length,
    created,
    failed,
  });
});

apiRouter.post("/projects/:projectId/github-integration/cleanup-duplicates", async (ctx) => {
  const projectId = ctx.req.param("projectId");
  requireProjectAccess(ctx, projectId, true);
  const dryRun = ctx.req.query("dryRun") === "true";

  try {
    const result = await cleanupDuplicateGithubIssues({ projectId, dryRun });
    return ctx.json(result);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Cleanup failed");
  }
});
