import { ClickHouseError, type ClickHouseClient } from "@clickhouse/client";
import { getClickHouseClient } from "../db/clickhouse";
import { all, one, run } from "../db/sqlite";
import { HttpError } from "./http";
import { ensureGithubIssueForGroup, getGithubIntegration } from "./issue-sync";
import { normalizeEvent, toClickHouseDateTime } from "./ingest";
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

// The ClickHouse errors that mean "the server read this INSERT and refused the data in it". Every one measured so far is a
// parse error: a timestamp that does not parse (CANNOT_PARSE_DATETIME), a shape the DateTime64 reader rejects
// (CANNOT_PARSE_INPUT_ASSERTION_FAILED) and a lone surrogate (CANNOT_PARSE_ESCAPE_SEQUENCE). A ClickHouseError is not
// enough to decide, because the client throws one for any answer from the server: a missing table, a missing database and a
// wrong password (UNKNOWN_TABLE, UNKNOWN_DATABASE, AUTHENTICATION_FAILED, all measured) are ClickHouseErrors too, and there
// every row is refused, so dropping them would lose the whole bucket where today it is kept until the server is fixed. A
// connection error is not a ClickHouseError at all. A type is added here only after an engine probe shows it for bad data;
// an unlisted type keeps the bucket, which is the behaviour from before this check existed.
function isRejectedData(error: unknown): error is ClickHouseError {
  return error instanceof ClickHouseError && /^CANNOT_PARSE_/.test(error.type ?? "");
}

// INSERTs `rows`; if the server refuses them as bad data, halves them and retries each half, so that only the rows the server
// still refuses on their own are dropped, and returns their positions in `rows`. A parse error names a row in its message,
// but the message quotes the input, so it is not used. Any other failure is thrown: the caller keeps the bucket.
//
// Cost, only on the failure path: about two INSERTs per level of halving per refused row (13 for one bad row in 64, 29 in
// 10000) instead of one per row, because every INSERT is a MergeTree part and ClickHouse throws TOO_MANY_PARTS past a few
// thousand. The remaining duplicate risk: if an outage starts mid-retry, the halves already inserted are inserted again by
// the next flush, which is the same exposure as an outage between two projects in flushBucket, and events has no key that
// dedupes. An INSERT of fewer rows than max_insert_block_size (about a million) is atomic, so a refused batch stored nothing
// and the halves do not duplicate it.
async function insertSkippingRefusedRows(
  client: ClickHouseClient,
  projectId: string,
  table: "events" | "breadcrumbs",
  rows: Array<Record<string, unknown> & { event_id: string }>,
  firstIndex = 0,
): Promise<number[]> {
  try {
    await client.insert({ table, values: rows, format: "JSONEachRow" });
    return [];
  } catch (error) {
    if (!isRejectedData(error)) {
      throw error;
    }
    if (rows.length === 1) {
      // Only ids and the error's code and type: its message quotes the refused input, which can hold user emails.
      console.error("[ingest-buffer] dropped a row ClickHouse refused", {
        projectId,
        table,
        eventId: rows[0].event_id,
        code: error.code,
        type: error.type,
      });
      return [firstIndex];
    }
    const middle = Math.ceil(rows.length / 2);
    return [
      ...(await insertSkippingRefusedRows(client, projectId, table, rows.slice(0, middle), firstIndex)),
      ...(await insertSkippingRefusedRows(client, projectId, table, rows.slice(middle), firstIndex + middle)),
    ];
  }
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
  const eventRows = events.map((event) => ({
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
  }));
  // Everything after this works on `stored`: a refused event gets no breadcrumbs, group reopening or GitHub issue.
  const refusedEventRows = new Set(await insertSkippingRefusedRows(client, projectId, "events", eventRows));
  const stored = events.filter((_, index) => !refusedEventRows.has(index));
  if (stored.length === 0) {
    return;
  }

  const breadcrumbs = stored.flatMap((event) =>
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
    await insertSkippingRefusedRows(client, projectId, "breadcrumbs", breadcrumbs);
  }

  const affectedGroupIds = [...new Set(stored.map((event) => event.groupId))];
  const reopenedAt = new Date().toISOString();
  for (const groupId of affectedGroupIds) {
    run(
      `UPDATE issue_workflows
       SET state = 'reopened', updated_at = ?, closed_at = NULL
       WHERE project_id = ? AND group_id = ? AND state = 'closed'`,
      [reopenedAt, projectId, groupId],
    );
  }

  await maybeCreateGithubIssues({ projectId, events: stored, affectedGroupIds });

  logIngestBuffer("finished ClickHouse batch", {
    projectId,
    eventCount: stored.length,
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

  // Deleted only after every project's insert has returned. An insert that throws leaves the bucket for the next flush, so
  // an outage does not lose events: ClickHouse unreachable, or a server error that is not about the data (the list is
  // isRejectedData). Its TTL is set at enqueue (INGEST_BUFFER_RETENTION_SECONDS), so a bucket that keeps failing is lost
  // whole when it expires. The cost of the retry is that projects inserted earlier in the loop are inserted again, because
  // events is a plain MergeTree and nothing dedupes on event_id. Neither a payload that cannot be normalised nor a row the
  // server refuses as bad data causes that retry any more: insertEvents drops them.
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
