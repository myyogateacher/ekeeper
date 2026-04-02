import { Hono } from "hono";
import { getClickHouseClient } from "../db/clickhouse";
import { one, run } from "../db/sqlite";
import { HttpError } from "../lib/http";
import { normalizeEvent, parseEnvelope } from "../lib/ingest";

interface ProjectKeyRow {
  projectId: string;
  publicKey: string;
  sentryProjectId: string;
}

function toClickHouseDateTime(value: string): string {
  return value.replace("T", " ").replace("Z", "");
}

async function storeEvents(projectId: string, payloads: Record<string, unknown>[]) {
  if (payloads.length === 0) {
    return;
  }

  const client = getClickHouseClient();
  const events = payloads.map((payload) => normalizeEvent(projectId, payload));
  await client.insert({
    table: "events",
    values: events.map((event) => ({
      event_id: event.eventId,
      project_id: event.projectId,
      group_id: event.groupId,
      fingerprint: event.fingerprint,
      title: event.title,
      message: event.message,
      severity: event.severity,
      timestamp: toClickHouseDateTime(event.timestamp),
      release: event.release ?? "",
      environment: event.environment ?? "",
      user_id: event.userId ?? "",
      browser: event.browser ?? "",
      device: event.device ?? "",
      os: event.os ?? "",
      runtime: event.runtime ?? "",
      tags: JSON.stringify(event.tags),
      contexts: JSON.stringify(event.contexts),
      exception: JSON.stringify(event.exception),
      stacktrace: JSON.stringify(event.stacktrace ?? {}),
      raw_payload: event.rawPayload,
    })),
    format: "JSONEachRow",
  });

  const breadcrumbs = events.flatMap((event) =>
    event.breadcrumbs.map((breadcrumb) => ({
      event_id: event.eventId,
      project_id: event.projectId,
      group_id: event.groupId,
      timestamp: toClickHouseDateTime(breadcrumb.timestamp),
      category: breadcrumb.category,
      level: breadcrumb.level,
      message: breadcrumb.message,
      type: breadcrumb.type,
      data: JSON.stringify(breadcrumb.data),
    })),
  );

  if (breadcrumbs.length > 0) {
    await client.insert({
      table: "breadcrumbs",
      values: breadcrumbs,
      format: "JSONEachRow",
    });
  }

  const affectedGroupIds = [...new Set(events.map((event) => event.groupId))];
  const reopenedAt = new Date().toISOString();
  for (const groupId of affectedGroupIds) {
    run(
      `UPDATE issue_workflows
       SET state = 'reopened', updated_at = ?, closed_at = NULL
       WHERE project_id = ? AND group_id = ? AND state = 'closed'`,
      [reopenedAt, projectId, groupId],
    );
  }
}

function resolveProject(publicKey: string, sentryProjectId?: string): ProjectKeyRow {
  const row = one<ProjectKeyRow>(
    `SELECT pk.project_id as projectId, pk.public_key as publicKey, p.sentry_project_id as sentryProjectId
     FROM project_keys pk
     INNER JOIN projects p ON p.id = pk.project_id
     WHERE pk.public_key = ?`,
    [publicKey],
  );
  if (!row) {
    throw new HttpError(404, "Project key not found");
  }
  if (sentryProjectId && row.sentryProjectId !== sentryProjectId) {
    throw new HttpError(400, "Invalid Sentry project identifier");
  }
  return row;
}

export const ingestRouter = new Hono();

async function handleStoreRequest(projectKey: string, sentryProjectId: string | undefined, payload: Record<string, unknown>) {
  const project = resolveProject(projectKey, sentryProjectId);
  await storeEvents(project.projectId, [payload]);
  return { id: payload.event_id ?? crypto.randomUUID(), status: "success" };
}

async function handleEnvelopeRequest(projectKey: string, sentryProjectId: string | undefined, raw: string) {
  const project = resolveProject(projectKey, sentryProjectId);
  const payloads = parseEnvelope(raw);
  await storeEvents(project.projectId, payloads);
  return { status: "success", accepted: payloads.length };
}

ingestRouter.post("/:projectKey/store", async (ctx) => {
  const payload = (await ctx.req.json()) as Record<string, unknown>;
  return ctx.json(await handleStoreRequest(ctx.req.param("projectKey"), undefined, payload));
});

ingestRouter.post("/:projectKey/envelope", async (ctx) => {
  const raw = await ctx.req.text();
  return ctx.json(await handleEnvelopeRequest(ctx.req.param("projectKey"), undefined, raw));
});

ingestRouter.post("/:projectKey/store/", async (ctx) => {
  const payload = (await ctx.req.json()) as Record<string, unknown>;
  return ctx.json(await handleStoreRequest(ctx.req.param("projectKey"), undefined, payload));
});

ingestRouter.post("/:projectKey/envelope/", async (ctx) => {
  const raw = await ctx.req.text();
  return ctx.json(await handleEnvelopeRequest(ctx.req.param("projectKey"), undefined, raw));
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/store", async (ctx) => {
  const payload = (await ctx.req.json()) as Record<string, unknown>;
  return ctx.json(
    await handleStoreRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), payload),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/envelope", async (ctx) => {
  const raw = await ctx.req.text();
  return ctx.json(
    await handleEnvelopeRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), raw),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/store/", async (ctx) => {
  const payload = (await ctx.req.json()) as Record<string, unknown>;
  return ctx.json(
    await handleStoreRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), payload),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/envelope/", async (ctx) => {
  const raw = await ctx.req.text();
  return ctx.json(
    await handleEnvelopeRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), raw),
  );
});
