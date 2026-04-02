import { Hono } from "hono";
import { one } from "../db/sqlite";
import { HttpError } from "../lib/http";
import { parseEnvelope } from "../lib/ingest";
import { enqueueBufferedIngest } from "../lib/ingest-buffer";

interface ProjectKeyRow {
  projectId: string;
  publicKey: string;
  sentryProjectId: string;
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
  console.log("[ingest] accepted store payload", {
    projectId: project.projectId,
    publicKey: project.publicKey,
    sentryProjectId: project.sentryProjectId,
    eventId: payload.event_id ?? null,
  });
  await enqueueBufferedIngest(project.projectId, [payload]);
  return { id: payload.event_id ?? crypto.randomUUID(), status: "success" };
}

async function handleEnvelopeRequest(projectKey: string, sentryProjectId: string | undefined, raw: string) {
  const project = resolveProject(projectKey, sentryProjectId);
  const payloads = parseEnvelope(raw);
  console.log("[ingest] accepted envelope payload", {
    projectId: project.projectId,
    publicKey: project.publicKey,
    sentryProjectId: project.sentryProjectId,
    acceptedCount: payloads.length,
  });
  await enqueueBufferedIngest(project.projectId, payloads);
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
