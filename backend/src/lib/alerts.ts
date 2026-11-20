import { createHash } from "node:crypto";
import type { NormalizedIngestEvent } from "@ekeeper/shared";
import { config } from "../config";
import { one } from "../db/sqlite";
import { connectRedis } from "./redis";
import { errorGroupUrl } from "./server-settings";

// Events of one signature inside one flushed bucket (5 minutes, INGEST_BUFFER_INTERVAL_MS in ingest-buffer.ts) that make a
// new error worth a Slack message. No alert threshold exists elsewhere in this repo to follow, so the data is the precedent:
// over a 7 day window of production traffic, 31 new project and title signatures reached 10 or more events in total. That is
// an upper bound for this threshold, because 10 inside one 5 minute bucket is stricter than 10 over a week, so new-error
// alerts should stay at or under about 4 a day (31 / 7). The count is per bucket, never carried over: a bug that stays at 9 or
// fewer events in every bucket does not alert, and the morning report remains the place it shows up.
export const ALERT_MIN_EVENTS_PER_BUCKET = 10;

// Neither the exception type (so neither the title) nor the release is capped at ingest, and both are chosen by whoever
// holds a DSN. Slack caps the size of a message's text, and an alert is read at a glance, so a title or release of
// whatever length the sender chose never reaches Slack whole: 500 characters holds any real exception line, 64 a commit SHA.
const TITLE_MAX_CHARS = 500;
const RELEASE_MAX_CHARS = 64;
// The flush is serial and holds a 300 s Redis lock (INGEST_FLUSH_LOCK_KEY in ingest-buffer.ts), so a post that never answers
// would stall every later bucket and, past the lock's expiry, let a second flush start on the same buckets.
const POST_TIMEOUT_MS = 5000;

export interface PlannedAlert {
  // "regression" is a closed issue that received an event again; "new" is a signature that crossed the threshold.
  kind: "new" | "regression";
  title: string;
  eventCount: number;
  // The group the message links to, see planIngestAlerts.
  groupId: string;
  release: string | null;
}

// Pure: decides which signatures of one project's flushed events deserve a message, so the rules are tested without Redis,
// SQLite or Slack, and sendIngestAlerts is left to execute the plan.
//
// A signature is project plus event.title, not the group id. A group id hashes the type, the value and the last 4 stack
// frames, so a minified frame name that changes between releases gives one bug a new group id per release, and counting per
// group would never reach the threshold for a bug that is spread thin over several of them. event.title is already
// `${type}: ${normalizeExceptionValue(value)}`, so it needs no further normalising here, which is why
// normalizeTitleForBucketing (private to issue-sync.ts, for GitHub titles stored by older normalisers) is not reused.
//
// Only events tagged environment "production" count. Production projects also receive events tagged staging from testenv
// builds (1,193 staging against 65,322 production events in 30 days, none with an empty environment), so the project's own
// environment column cannot do this filter: only the tag on the event tells them apart. The cost: a closed group reopened
// by a staging-tagged event is reopened silently, and the later production event no longer matches the reopen UPDATE (it
// matches only state = 'closed'), so that regression is not announced.
export function planIngestAlerts(
  events: Pick<NormalizedIngestEvent, "groupId" | "title" | "release" | "environment">[],
  reopenedGroupIds: ReadonlySet<string>,
): PlannedAlert[] {
  const bySignature = new Map<string, PlannedAlert>();
  for (const event of events) {
    if (event.environment !== "production") {
      continue;
    }
    const reopened = reopenedGroupIds.has(event.groupId);
    const alert = bySignature.get(event.title);
    if (!alert) {
      bySignature.set(event.title, {
        kind: reopened ? "regression" : "new",
        title: event.title,
        eventCount: 1,
        groupId: event.groupId,
        release: event.release,
      });
      continue;
    }
    alert.eventCount += 1;
    // The release the bug is on now, not the one it first appeared on.
    alert.release = event.release;
    // A person closed this as fixed, so one event of it is the signal whatever the count; link the reopened group, because
    // that is the one whose status and history the reader wants, even when a sibling group with the same title came first.
    if (reopened && alert.kind === "new") {
      alert.kind = "regression";
      alert.groupId = event.groupId;
    }
  }
  return [...bySignature.values()].filter(
    (alert) => alert.kind === "regression" || alert.eventCount >= ALERT_MIN_EVENTS_PER_BUCKET,
  );
}

// Slack reads `&`, `<` and `>` in message text as control characters: `<!channel>` pings everyone in the channel and
// `<https://x|y>` renders as a link, and ingest is public, so a sender can put either in a title or a release. These three
// entities are the escaping Slack's formatting rules ask for. Applied after clipping so an entity is never cut in half.
function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Slack has no escape for a backtick, so one inside the text would close the code span early and leave the rest of the
// title to be formatted as mrkdwn. It becomes a quote, which reads the same in an error message. A cut can land inside a
// surrogate pair, so the clipped text is made well formed again before it is sent as JSON.
function inlineCode(text: string, maxChars: number): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars).toWellFormed()}...` : text;
  return `\`${escapeSlack(clipped).replaceAll("`", "'")}\``;
}

// Pure, like the planner: the message is the contract with the channel, and it is tested as text. Mentions are never
// produced here (no `<!channel>`, no `<!here>`); the only angle brackets are the link this function builds.
export function formatIngestAlert(alert: PlannedAlert, projectName: string, projectId: string): string {
  const heading = alert.kind === "new" ? "New error" : "Closed issue is back";
  const count = `${alert.eventCount} ${alert.eventCount === 1 ? "event" : "events"}`;
  const lines = [
    `*${heading}* in ${escapeSlack(projectName)}`,
    `${count} in one 5 minute window`,
    inlineCode(alert.title, TITLE_MAX_CHARS),
  ];
  if (alert.release) {
    lines.push(`Release ${inlineCode(alert.release, RELEASE_MAX_CHARS)}`);
  }
  lines.push(`<${errorGroupUrl(projectId, alert.groupId)}|Open in eKeeper>`);
  return lines.join("\n");
}

// The class name of a failure and nothing else, the same rule as errorName in ingest-buffer.ts (a message can quote the
// payload, and payloads hold user emails). Repeated here instead of imported because ingest-buffer imports this file.
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "non-Error thrown";
}

// Posts the alerts for one project's flushed events. Called from insertEvents, so it never throws: a throw out of
// insertEvents leaves the bucket in Redis, and the next flush then inserts every event of the bucket again (see the comment
// above `redis.del(redisKey)` in flushBucket), which would turn a Slack outage into duplicated events. Every failure is
// logged with the project, the kind and the HTTP status or error class, never the webhook URL (a credential: anyone holding
// it can post to the channel) and never the title or any other payload text (titles can hold user emails).
export async function sendIngestAlerts(
  projectId: string,
  events: Pick<NormalizedIngestEvent, "groupId" | "title" | "release" | "environment">[],
  reopenedGroupIds: ReadonlySet<string>,
): Promise<void> {
  // Read at call time, before any Redis or SQL work, so an unconfigured deploy pays nothing per project per bucket.
  const webhookUrl = config.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }
  try {
    const planned = planIngestAlerts(events, reopenedGroupIds);
    if (planned.length === 0) {
      return;
    }
    const projectName =
      one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [projectId])?.name ?? projectId;
    const redis = await connectRedis();

    for (const alert of planned) {
      // One key per signature that ever alerted, with no TTL: at the rate estimated at ALERT_MIN_EVENTS_PER_BUCKET that is
      // at most about 120 keys a month, and a key that expired would re-announce a bug that is simply still firing.
      // Re-alerting after a person closes the issue is what the regression path is for. Hashed because a title is as long as the sender made it. Keyed by title, not group id,
      // for the reason given at planIngestAlerts.
      const key = `ekeeper:alert:sent:${createHash("sha256").update(`${projectId}\n${alert.title}`).digest("hex")}`;
      let claimed = false;
      let reason: string;
      try {
        // Claimed before the post, so two workers, or a retried bucket, cannot both announce the same signature. A
        // regression sets the key too and posts whatever the answer was, so that the same signature does not go out again
        // as "new" on the next flush, once its group is no longer closed.
        claimed = (await redis.set(key, "1", { NX: true })) === "OK";
        if (alert.kind === "new" && !claimed) {
          continue;
        }
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: formatIngestAlert(alert, projectName, projectId) }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        if (response.ok) {
          continue;
        }
        reason = `HTTP ${response.status}`;
      } catch (error) {
        reason = failureName(error);
      }
      console.error("[alerts] post failed", { projectId, kind: alert.kind, reason });
      // Released only when this call created the key. A key left in place after a failed post would silence the signature
      // for good, because the claim was written before the side effect it guards. A regression that fails here is not
      // retried by the next flush either way, since the reopen UPDATE no longer matches; only a later burst can alert it.
      if (claimed) {
        await redis.del(key);
      }
    }
  } catch (error) {
    console.error("[alerts] could not plan or send alerts", { projectId, reason: failureName(error) });
  }
}
