import { getClickHouseClient } from "../db/clickhouse";
import { all, one, run } from "../db/sqlite";
import { HttpError } from "./http";
import { ensureGithubIssueForGroup, getGithubIntegration } from "./issue-sync";
import { normalizeEvent } from "./ingest";
import { connectRedis } from "./redis";

interface BufferedIngestEntry {
  projectId: string;
  payload: Record<string, unknown>;
}

const INGEST_BUFFER_PREFIX = "ekeeper:ingest-buffer";
const INGEST_FLUSH_LOCK_KEY = "ekeeper:ingest-buffer:flush-lock";
const INGEST_BUFFER_INTERVAL_MS = 5 * 60 * 1000;
const INGEST_BUFFER_RETENTION_SECONDS = 48 * 60 * 60;

function logIngestBuffer(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[ingest-buffer] ${message}`, details);
    return;
  }

  console.log(`[ingest-buffer] ${message}`);
}

function toClickHouseDateTime(value: string): string {
  return value.replace("T", " ").replace("Z", "");
}

function extractExceptionType(exception: Record<string, unknown> | null | undefined): string | null {
  if (!exception || typeof exception !== "object") {
    return null;
  }
  const values = Array.isArray((exception as Record<string, unknown>).values)
    ? ((exception as Record<string, unknown>).values as Array<Record<string, unknown>>)
    : [];
  const primary = values[0];
  if (primary && typeof primary.type === "string" && primary.type.length > 0) {
    return primary.type;
  }
  return null;
}

function roundDateToFiveMinutes(date: Date) {
  const rounded = new Date(date);
  rounded.setUTCSeconds(0, 0);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / 5) * 5);
  return rounded;
}

function buildBucketKey(date: Date) {
  return `${INGEST_BUFFER_PREFIX}:${roundDateToFiveMinutes(date).toISOString()}`;
}

function groupByProject(entries: BufferedIngestEntry[]) {
  const grouped = new Map<string, Record<string, unknown>[]>();

  for (const entry of entries) {
    const bucket = grouped.get(entry.projectId) ?? [];
    bucket.push(entry.payload);
    grouped.set(entry.projectId, bucket);
  }

  return grouped;
}

async function insertEvents(projectId: string, payloads: Record<string, unknown>[]) {
  if (payloads.length === 0) {
    return;
  }

  // Normalised one payload at a time, and a payload that throws is dropped here instead of aborting the batch. This
  // used to be `payloads.map(normalizeEvent)`, so one bad event failed every good event of its project and then the
  // whole bucket (PROD-10530). Dropping is safe, unlike retrying: normalizeEvent is deterministic, so the same
  // payload would fail on every flush until the bucket expires. Only the project id and the error are logged, never the
  // payload, which can hold user emails. No JSON shape is known to make normalizeEvent throw today, so this is the
  // backstop for a future normalizeEvent bug: the gate in enqueueBufferedIngest would refuse such a payload, but one
  // buffered by an older build never passed the current gate.
  const events: ReturnType<typeof normalizeEvent>[] = [];
  let rejectedCount = 0;
  for (const payload of payloads) {
    try {
      events.push(normalizeEvent(projectId, payload));
    } catch (error) {
      rejectedCount += 1;
      console.error("[ingest-buffer] dropped a payload that failed normalisation", {
        projectId,
        reason: String(error),
      });
    }
  }
  if (events.length === 0) {
    return;
  }

  logIngestBuffer("writing project batch to ClickHouse", {
    projectId,
    eventCount: events.length,
    rejectedCount,
  });

  const client = getClickHouseClient();
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
      user_email: event.userEmail ?? "",
      user_username: event.userUsername ?? "",
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
    logIngestBuffer("writing breadcrumb batch to ClickHouse", {
      projectId,
      breadcrumbCount: breadcrumbs.length,
    });
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

  await maybeCreateGithubIssues({ projectId, events, affectedGroupIds });

  logIngestBuffer("finished ClickHouse batch", {
    projectId,
    eventCount: events.length,
    breadcrumbCount: breadcrumbs.length,
    reopenedGroupCount: affectedGroupIds.length,
  });
}

async function maybeCreateGithubIssues(input: {
  projectId: string;
  events: ReturnType<typeof normalizeEvent>[];
  affectedGroupIds: string[];
}): Promise<void> {
  if (input.affectedGroupIds.length === 0) {
    return;
  }
  const integration = getGithubIntegration(input.projectId);
  if (!integration) {
    return;
  }

  const project = one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [
    input.projectId,
  ]);
  if (!project) {
    return;
  }

  const placeholders = input.affectedGroupIds.map(() => "?").join(", ");
  const existingLinks = all<{ groupId: string }>(
    `SELECT group_id as groupId FROM error_group_github_issues
     WHERE project_id = ? AND group_id IN (${placeholders})`,
    [input.projectId, ...input.affectedGroupIds],
  );
  const linkedGroups = new Set(existingLinks.map((row) => row.groupId));
  const unlinkedGroups = input.affectedGroupIds.filter((groupId) => !linkedGroups.has(groupId));
  if (unlinkedGroups.length === 0) {
    return;
  }

  const firstEventByGroup = new Map<string, ReturnType<typeof normalizeEvent>>();
  for (const event of input.events) {
    if (!firstEventByGroup.has(event.groupId)) {
      firstEventByGroup.set(event.groupId, event);
    }
  }

  for (const groupId of unlinkedGroups) {
    const event = firstEventByGroup.get(groupId);
    if (!event) {
      continue;
    }
    await ensureGithubIssueForGroup({
      projectId: input.projectId,
      projectName: project.name,
      groupId,
      title: event.title,
      fingerprint: event.fingerprint,
      firstSeen: event.timestamp,
      message: event.message,
      release: event.release,
      exceptionType: extractExceptionType(event.exception),
      stacktrace: event.stacktrace,
      exception: event.exception,
      rawPayload: event.rawPayload,
    });
  }
}

async function flushBucket(redisKey: string) {
  const redis = await connectRedis();
  const items = await redis.lRange(redisKey, 0, -1);

  logIngestBuffer("starting bucket flush", {
    redisKey,
    bufferedItemCount: items.length,
  });

  if (items.length === 0) {
    await redis.del(redisKey);
    logIngestBuffer("deleted empty bucket", { redisKey });
    return;
  }

  const entries = items
    .map((item) => {
      try {
        return JSON.parse(item) as BufferedIngestEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is BufferedIngestEntry => Boolean(entry?.projectId && entry.payload));

  const grouped = groupByProject(entries);
  logIngestBuffer("grouped buffered items for flush", {
    redisKey,
    parsedEntryCount: entries.length,
    projectCount: grouped.size,
  });
  for (const [projectId, payloads] of grouped) {
    await insertEvents(projectId, payloads);
  }

  // Deleted only after every project's insert has returned. An insert that throws (ClickHouse down, a row it refuses)
  // leaves the bucket for the next flush so an outage does not lose events; its TTL is set at enqueue
  // (INGEST_BUFFER_RETENTION_SECONDS), so a bucket that keeps failing is lost whole when it expires. The cost of the retry
  // is that projects inserted earlier in the loop are inserted again, because events is a plain MergeTree and nothing
  // dedupes on event_id. A payload that cannot be normalised no longer causes that retry: insertEvents drops it.
  await redis.del(redisKey);
  logIngestBuffer("completed bucket flush", {
    redisKey,
    flushedEntryCount: entries.length,
    projectCount: grouped.size,
  });
}

// Why a payload may not enter the buffer, or null when it may. The routes cast the request body to a Record without
// checking it, so a body of `null`, a number or an array reaches here typed as an object; the flush would drop a falsy
// one silently and store a truthy one as an empty event.
function refusalReason(projectId: string, payload: Record<string, unknown>): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "payload is not a JSON object";
  }
  try {
    normalizeEvent(projectId, payload);
    return null;
  } catch (error) {
    return String(error);
  }
}

export async function enqueueBufferedIngest(projectId: string, payloads: Record<string, unknown>[]) {
  if (payloads.length === 0) {
    return;
  }

  // Every public ingest route funnels through here, so this is the one gate in front of Redis. A payload that
  // normalizeEvent cannot process used to be accepted with a 200 and then stall its bucket at flush (PROD-10530). Refusing
  // it here with a 400 tells the sender its body was refused, instead of acknowledging an event that is dropped five
  // minutes later, and keeps it out of Redis. The cost is a second normalizeEvent per event on the request path, bounded
  // by the length caps in ingest.ts. The buffer still holds raw payloads: buckets already in Redis at deploy time do, and
  // a new stored shape would need a reader for both. All payloads are checked before any is buffered, so an envelope is
  // accepted or refused whole and a 200 never covers an event that was then dropped.
  for (const payload of payloads) {
    const reason = refusalReason(projectId, payload);
    if (reason) {
      console.warn("[ingest-buffer] refused a payload", { projectId, reason });
      throw new HttpError(400, "Event payload could not be processed");
    }
  }

  const redis = await connectRedis();
  const key = buildBucketKey(new Date());
  const serialized = payloads.map((payload) =>
    JSON.stringify({
      projectId,
      payload,
    } satisfies BufferedIngestEntry),
  );

  await redis
    .multi()
    .rPush(key, serialized)
    .expire(key, INGEST_BUFFER_RETENTION_SECONDS)
    .exec();

  logIngestBuffer("buffered incoming payloads", {
    projectId,
    redisKey: key,
    payloadCount: payloads.length,
  });
}

export async function flushBufferedIngest() {
  const redis = await connectRedis();
  const lock = await redis.set(INGEST_FLUSH_LOCK_KEY, String(Date.now()), {
    NX: true,
    EX: Math.ceil(INGEST_BUFFER_INTERVAL_MS / 1000),
  });

  if (!lock) {
    logIngestBuffer("skipping flush because another worker holds the lock");
    return;
  }

  try {
    const currentKey = buildBucketKey(new Date());
    const keys = await redis.keys(`${INGEST_BUFFER_PREFIX}:*`);
    const eligibleKeys = keys.filter((key) => key !== currentKey && key !== INGEST_FLUSH_LOCK_KEY).sort();

    logIngestBuffer("evaluated buffered ingest keys", {
      currentKey,
      discoveredKeyCount: keys.length,
      eligibleKeyCount: eligibleKeys.length,
      eligibleKeys,
    });

    for (const key of eligibleKeys) {
      try {
        await flushBucket(key);
      } catch (error) {
        console.error("[ingest-buffer] bucket flush failed", {
          redisKey: key,
          error,
        });
      }
    }
  } finally {
    await redis.del(INGEST_FLUSH_LOCK_KEY);
    logIngestBuffer("released flush lock");
  }
}

export function startBufferedIngestFlusher() {
  logIngestBuffer("starting periodic ingest flusher", {
    intervalMs: INGEST_BUFFER_INTERVAL_MS,
  });
  void flushBufferedIngest();
  return setInterval(() => {
    void flushBufferedIngest();
  }, INGEST_BUFFER_INTERVAL_MS);
}
