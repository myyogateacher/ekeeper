import { getClickHouseClient } from "../db/clickhouse";
import { run } from "../db/sqlite";
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

function toClickHouseDateTime(value: string): string {
  return value.replace("T", " ").replace("Z", "");
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

async function flushBucket(redisKey: string) {
  const redis = await connectRedis();
  const items = await redis.lRange(redisKey, 0, -1);

  if (items.length === 0) {
    await redis.del(redisKey);
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
  for (const [projectId, payloads] of grouped) {
    await insertEvents(projectId, payloads);
  }

  await redis.del(redisKey);
  console.log(`[ingest] flushed ${entries.length} buffered event(s) from ${redisKey}`);
}

export async function enqueueBufferedIngest(projectId: string, payloads: Record<string, unknown>[]) {
  if (payloads.length === 0) {
    return;
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
}

export async function flushBufferedIngest() {
  const redis = await connectRedis();
  const lock = await redis.set(INGEST_FLUSH_LOCK_KEY, String(Date.now()), {
    NX: true,
    EX: Math.ceil(INGEST_BUFFER_INTERVAL_MS / 1000),
  });

  if (!lock) {
    return;
  }

  try {
    const currentKey = buildBucketKey(new Date());
    const keys = await redis.keys(`${INGEST_BUFFER_PREFIX}:*`);
    const eligibleKeys = keys.filter((key) => key !== currentKey && key !== INGEST_FLUSH_LOCK_KEY).sort();

    for (const key of eligibleKeys) {
      await flushBucket(key);
    }
  } finally {
    await redis.del(INGEST_FLUSH_LOCK_KEY);
  }
}

export function startBufferedIngestFlusher() {
  void flushBufferedIngest();
  return setInterval(() => {
    void flushBufferedIngest();
  }, INGEST_BUFFER_INTERVAL_MS);
}
