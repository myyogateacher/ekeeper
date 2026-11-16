import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { one } from "../db/sqlite";
import { HttpError } from "../lib/http";
import { INGEST_MAX_BODY_BYTES, parseEnvelope, parseUntrustedJson } from "../lib/ingest";
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

// Same 413 JSON shape as bodyTooLarge in routes/api.ts (affected-users), the house pattern for bodyLimit. This router is
// public, so the cap is the first thing every request meets, before the project lookup and before any parse.
ingestRouter.use(
  "*",
  bodyLimit({
    maxSize: INGEST_MAX_BODY_BYTES,
    onError: (ctx) => ctx.json({ message: "Request body too large" }, 413),
  }),
);

// A chunked body past the limit makes this read throw the error bodyLimit raised, which hono/body-limit does not export, so
// it is matched by name as in api.ts. Turned into an HttpError here so app.onError answers it without console.error: a
// public sender could otherwise write a stack trace to the server log per request.
async function readText(ctx: Context): Promise<string> {
  try {
    return await ctx.req.text();
  } catch (error) {
    if (error instanceof Error && error.name === "BodyLimitError") {
      throw new HttpError(413, "Request body too large");
    }
    throw error;
  }
}

async function readStorePayload(ctx: Context) {
  return parseUntrustedJson(await readText(ctx)) as Record<string, unknown>;
}

async function handleStoreRequest(projectKey: string, sentryProjectId: string | undefined, payload: Record<string, unknown>) {
  const project = resolveProject(projectKey, sentryProjectId);
  // Enqueued before the "accepted" log and the event_id reads: enqueueBufferedIngest refuses a body that is not a JSON
  // object, and `null` has no event_id to read, so reading it first answered a null body with a 500 instead of a 400.
  await enqueueBufferedIngest(project.projectId, [payload]);
  console.log("[ingest] accepted store payload", {
    projectId: project.projectId,
    publicKey: project.publicKey,
    sentryProjectId: project.sentryProjectId,
    eventId: payload.event_id ?? null,
  });
  return { id: payload.event_id ?? crypto.randomUUID(), status: "success" };
}

async function handleEnvelopeRequest(projectKey: string, sentryProjectId: string | undefined, raw: string) {
  const project = resolveProject(projectKey, sentryProjectId);
  const payloads = parseEnvelope(raw);
  // Logged after the gate, as in the store route: enqueueBufferedIngest refuses an envelope whole, and a refused envelope
  // must not show up as accepted in the log.
  await enqueueBufferedIngest(project.projectId, payloads);
  console.log("[ingest] accepted envelope payload", {
    projectId: project.projectId,
    publicKey: project.publicKey,
    sentryProjectId: project.sentryProjectId,
    acceptedCount: payloads.length,
  });
  return { status: "success", accepted: payloads.length };
}

ingestRouter.post("/:projectKey/store", async (ctx) => {
  const payload = await readStorePayload(ctx);
  return ctx.json(await handleStoreRequest(ctx.req.param("projectKey"), undefined, payload));
});

ingestRouter.post("/:projectKey/envelope", async (ctx) => {
  const raw = await readText(ctx);
  return ctx.json(await handleEnvelopeRequest(ctx.req.param("projectKey"), undefined, raw));
});

ingestRouter.post("/:projectKey/store/", async (ctx) => {
  const payload = await readStorePayload(ctx);
  return ctx.json(await handleStoreRequest(ctx.req.param("projectKey"), undefined, payload));
});

ingestRouter.post("/:projectKey/envelope/", async (ctx) => {
  const raw = await readText(ctx);
  return ctx.json(await handleEnvelopeRequest(ctx.req.param("projectKey"), undefined, raw));
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/store", async (ctx) => {
  const payload = await readStorePayload(ctx);
  return ctx.json(
    await handleStoreRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), payload),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/envelope", async (ctx) => {
  const raw = await readText(ctx);
  return ctx.json(
    await handleEnvelopeRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), raw),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/store/", async (ctx) => {
  const payload = await readStorePayload(ctx);
  return ctx.json(
    await handleStoreRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), payload),
  );
});

ingestRouter.post("/:projectKey/api/:sentryProjectId/envelope/", async (ctx) => {
  const raw = await readText(ctx);
  return ctx.json(
    await handleEnvelopeRequest(ctx.req.param("projectKey"), ctx.req.param("sentryProjectId"), raw),
  );
});
