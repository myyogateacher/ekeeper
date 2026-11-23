import { createHash } from "node:crypto";
import type { NormalizedIngestEvent } from "@ekeeper/shared";
import { config } from "../config";
import { one } from "../db/sqlite";
import { connectRedis } from "./redis";
import { errorGroupUrl } from "./server-settings";

// Events of one signature inside one flushed bucket (5 minutes, INGEST_BUFFER_INTERVAL_MS in ingest-buffer.ts) that make an
// error burst worth a Slack message. No alert threshold exists elsewhere in this repo to follow, so the data is the
// precedent: over a 7 day window of production traffic, 31 project and title signatures first seen in that window reached 10
// or more events in total. That is an upper bound for this threshold, because 10 inside one 5 minute bucket is stricter than
// 10 over a week, so bursts of errors that are new should stay at or under about 4 a day (31 / 7). It is an estimate for
// the steady state only: an error that already existed alerts once, the first time it bursts, so the first days after this
// ships can run above it. The count is per bucket, never carried over: a bug that stays at 9 or fewer events in every
// bucket does not alert, and the morning report remains the place it shows up.
export const ALERT_MIN_EVENTS_PER_BUCKET = 10;

// Titles one message lists, which is what bounds a flood: ingest has no rate limit, so whoever holds a DSN can make any
// number of titles cross the threshold, and Slack answers 429 to a webhook above about one message a second, which would
// drop the real alert along with the rest. One message per project per bucket, listing at most this many titles, is at most
// one post per project per bucket however many titles there are (a backlog flushed after downtime posts one per project per
// bucket, back to back). 10 is the same data precedent as the threshold: about 4 bursts a day in steady state leaves a normal
// bucket far below it, so the cap only bites on a flood or a mass regression.
//
// What is past the cap is counted, not listed, and the two kinds differ. A burst past the cap is left unclaimed, so it can
// still alert in a later bucket, and it is counted only if it has never alerted. A regression past the cap cannot be retried:
// the reopen UPDATE matches a group only while it is closed, so the flush that reopened it is the only one that sees it, and
// the count in the message is the only announcement it gets.
const ALERTS_PER_MESSAGE = 10;

// Neither the exception type (so neither the title) nor the release is capped at ingest, and both are chosen by whoever
// holds a DSN. Slack caps the size of a message's text, and an alert is read at a glance, so a title or release of
// whatever length the sender chose never reaches Slack whole: 500 characters holds any real exception line, 64 a commit SHA.
const TITLE_MAX_CHARS = 500;
const RELEASE_MAX_CHARS = 64;
// Deliveries run one at a time on the chain below, so a post that never answers holds every later alert behind it for up to
// this long, and a run of them for this long each. The timeout is the only bound on the queue's latency. The flush does not
// wait for it (see queueIngestAlerts), so it is the delay of an alert and never the delay of an insert.
const POST_TIMEOUT_MS = 5000;

export interface PlannedAlert {
  // "regression" is a closed issue that received an event again. "burst" is a signature that crossed the threshold while no
  // dedup key exists for it, and the first alert writes the key. That is not the same as new: an error that has existed for
  // weeks alerts the first time it bursts after this shipped, so no text shown to a reader may call a burst new.
  kind: "burst" | "regression";
  title: string;
  eventCount: number;
  // The group the message links to, see planIngestAlerts.
  groupId: string;
  release: string | null;
}

// Pure: decides which signatures of one project's flushed events deserve a message, so the rules are tested without Redis,
// SQLite or Slack, and deliverProjectAlerts is left to execute the plan. The order of the result is part of the contract,
// because the message lists only the first ALERTS_PER_MESSAGE: regressions first, then bursts by event count, largest first.
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
        kind: reopened ? "regression" : "burst",
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
    if (reopened && alert.kind === "burst") {
      alert.kind = "regression";
      alert.groupId = event.groupId;
    }
  }
  const rank = (alert: PlannedAlert) => (alert.kind === "regression" ? 0 : 1);
  return [...bySignature.values()]
    .filter((alert) => alert.kind === "regression" || alert.eventCount >= ALERT_MIN_EVENTS_PER_BUCKET)
    .sort((a, b) => rank(a) - rank(b) || b.eventCount - a.eventCount);
}

// Slack reads `&`, `<` and `>` in message text as control characters: `<!channel>` pings everyone in the channel and
// `<https://x|y>` renders as a link, and ingest is public, so a sender can put either in a title or a release. These three
// entities are the escaping Slack's formatting rules ask for. Applied after clipping so an entity is never cut in half.
function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Sender text (a title or a release) made safe to sit inside one line of the message. Whitespace runs collapse to one space
// first: the exception type is neither normalised nor capped and the release is stored verbatim, so either can hold a line
// break, which would end the title's link or the release's code span and put the rest on a line of its own, where it reads
// as a line of the message and a bare URL in it becomes a link to wherever the sender chose. U+0085 (next line) is added to `\s` because JavaScript's `\s`
// does not match it. A cut can land inside a surrogate pair, so the clipped text is made well formed again before it is sent
// as JSON.
function senderText(text: string, maxChars: number): string {
  const flat = text.replace(/[\s\u0085]+/g, " ");
  const clipped = flat.length > maxChars ? `${flat.slice(0, maxChars).toWellFormed()}...` : flat;
  return escapeSlack(clipped);
}

// What did not fit under ALERTS_PER_MESSAGE, by kind, because the two are announced differently (see ALERTS_PER_MESSAGE):
// `regressions` is every closed issue that came back past the cap, `bursts` only the bursts past the cap that never alerted.
export interface LeftOut {
  regressions: number;
  bursts: number;
}

// Pure, like the planner: the message is the contract with the channel, and it is tested as text. `alerts` are the titles
// listed and `leftOut` what was counted instead of listed. One line per alert, the title being the link to its group so the
// line stays short. The part before the `|` is always errorGroupUrl, which percent-encodes the group id and so holds no `|`
// or `>`, and the title after it has its `>` escaped, so a sender chooses what the link says but cannot end the link early
// or change where it goes. "in 5 min" is on bursts only, because that is the threshold's window; a regression is one event
// whatever the window. The header says production because the planner counts nothing else. Mentions are never produced here
// (no `<!channel>`, no `<!here>`); the only angle brackets are the links this function builds.
export function formatIngestAlerts(alerts: PlannedAlert[], leftOut: LeftOut, projectName: string, projectId: string): string {
  const lines = [`*${escapeSlack(projectName)}* · production`];
  for (const alert of alerts) {
    const label = alert.kind === "regression" ? ":repeat: Closed issue is back" : ":fire: Error burst";
    const count = `${alert.eventCount} ${alert.eventCount === 1 ? "event" : "events"}${alert.kind === "burst" ? " in 5 min" : ""}`;
    // The release is outside the link, where Slack turns a bare URL into a link of its own, so a sender could put a link to
    // anywhere beside the real one. Slack does not link inside a code span, hence the backticks; it has no escape for a
    // backtick either, so one in the release becomes a quote instead of closing the span early.
    const release = alert.release ? `, \`${senderText(alert.release, RELEASE_MAX_CHARS).replaceAll("`", "'")}\`` : "";
    lines.push(
      `${label}: <${errorGroupUrl(projectId, alert.groupId)}|${senderText(alert.title, TITLE_MAX_CHARS)}> (${count}${release})`,
    );
  }
  const parts: string[] = [];
  if (leftOut.regressions > 0) {
    parts.push(`${leftOut.regressions} closed ${leftOut.regressions === 1 ? "issue" : "issues"}`);
  }
  if (leftOut.bursts > 0) {
    parts.push(`${leftOut.bursts} ${leftOut.bursts === 1 ? "burst" : "bursts"}`);
  }
  if (parts.length > 0) {
    lines.push(`+${leftOut.regressions + leftOut.bursts} more not shown (${parts.join(", ")})`);
  }
  return lines.join("\n");
}

// The class name of a failure and nothing else, the same rule as errorName in ingest-buffer.ts (a message can quote the
// payload, and payloads hold user emails). Repeated here instead of imported because ingest-buffer imports this file.
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "non-Error thrown";
}

// One key per signature that ever alerted, with no TTL: at the rate estimated at ALERT_MIN_EVENTS_PER_BUCKET that is at
// most about 120 keys a month, and a key that expired would re-announce a bug that is simply still firing. Re-alerting after
// a person closes the issue is what the regression path is for. Hashed because a title is as long as the sender made it.
// Keyed by title, not group id, for the reason given at planIngestAlerts.
function alertKey(projectId: string, title: string): string {
  return `ekeeper:alert:sent:${createHash("sha256").update(`${projectId}\n${title}`).digest("hex")}`;
}

// Posts one project's message for one bucket. It may throw (Redis or SQLite failing outside the post); the chain it runs on
// catches that, see `deliveries`. Every failure is logged with the project, the number of titles and the HTTP status or
// error class, never the webhook URL (a credential: anyone holding it can post to the channel) and never a title or any
// other payload text (titles can hold user emails).
async function deliverProjectAlerts(webhookUrl: string, projectId: string, planned: PlannedAlert[]): Promise<void> {
  const redis = await connectRedis();
  const projectName = one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [projectId])?.name ?? projectId;
  const claimedKeys: string[] = [];
  const listed: PlannedAlert[] = [];
  const leftOut: LeftOut = { regressions: 0, bursts: 0 };
  const leftOutBurstKeys: string[] = [];
  let reason: string;
  try {
    for (const alert of planned) {
      // Candidates past the cap are neither claimed nor listed, see ALERTS_PER_MESSAGE. A burst's key is kept to ask Redis
      // below whether it has alerted before.
      if (listed.length === ALERTS_PER_MESSAGE) {
        if (alert.kind === "regression") {
          leftOut.regressions += 1;
        } else {
          leftOutBurstKeys.push(alertKey(projectId, alert.title));
        }
        continue;
      }
      const key = alertKey(projectId, alert.title);
      // Claimed before the post, so two workers, or a retried bucket, cannot both announce the same signature. A burst that
      // loses the claim has alerted before and is skipped. A regression sets the key too but is listed whatever the answer
      // was, so that the same signature does not go out again as a burst on the next flush, once its group is no longer
      // closed.
      const claimed = (await redis.set(key, "1", { NX: true })) === "OK";
      if (claimed) {
        claimedKeys.push(key);
      }
      if (claimed || alert.kind === "regression") {
        listed.push(alert);
      }
    }
    if (listed.length === 0) {
      return;
    }
    if (leftOutBurstKeys.length > 0) {
      // EXISTS answers how many of the keys are set. Those bursts have alerted before and would never be listed, so only
      // the rest are "more": errors the reader has not been told about and a later window can still announce.
      leftOut.bursts = leftOutBurstKeys.length - (await redis.exists(leftOutBurstKeys));
    }
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: formatIngestAlerts(listed, leftOut, projectName, projectId) }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (response.ok) {
      return;
    }
    reason = `HTTP ${response.status}`;
  } catch (error) {
    reason = failureName(error);
  }
  console.error("[alerts] delivery failed", { projectId, alertCount: listed.length, reason });
  // Released for the keys this delivery created, all of them, because one post carries them all. A key left in place after
  // a failed post would silence its signature for good, since the claim was written before the side effect it guards.
  // That does not make every failed alert retryable. A failed regression is not detected again by the next flush, because
  // the reopen UPDATE no longer matches. A later burst of its title can alert only if this call created, and so released,
  // the key; if the title had alerted before, the claim fails on every later burst and it stays silent until a person
  // closes the issue again.
  if (claimedKeys.length > 0) {
    await redis.del(claimedKeys);
  }
}

// The delivery chain. Alerts are delivered one at a time, in the order queued, for two reasons: Slack answers 429 to a
// webhook above about one message a second (with short bursts allowed), and one post in flight means a hung one delays the
// later alerts by at most POST_TIMEOUT_MS each instead of piling up sockets. It is module level because one process runs one
// flusher; two workers are kept from announcing the same signature by the claim in deliverProjectAlerts, not by this chain.
// The tail is always caught: a rejection left in it would make every later `.then` skip its delivery for the life of the
// process, so a delivery that throws is logged here and the next one runs.
let deliveries: Promise<void> = Promise.resolve();

// Queues the alerts for one project's flushed events and returns at once. Called from insertEvents, and it must not wait for
// Slack: the flush is serial and holds a 300 s Redis lock that is never renewed, while the timer fires every 300 s, so a
// flush that outlives the lock is joined by the next tick, which inserts the same buckets again (every event stored twice).
// Each post is bounded to POST_TIMEOUT_MS, but the number of alerts is not bounded by anything the server controls, so
// waiting on them has no bound of its own. For the same reason it does not throw: a throw out of insertEvents keeps the
// bucket in Redis and the next flush inserts every event of it again (see the comment above `redis.del(redisKey)` in
// flushBucket), which would turn a Slack outage into duplicated events.
//
// The webhook is read at call time, before any planning, so an unconfigured deploy pays nothing per project per bucket. The
// plan is made here, synchronously, so that what the queue retains is the planned alerts (a title and a count each) and
// never `events`, which carry the raw payloads of the whole batch.
export function queueIngestAlerts(
  projectId: string,
  events: Pick<NormalizedIngestEvent, "groupId" | "title" | "release" | "environment">[],
  reopenedGroupIds: ReadonlySet<string>,
): void {
  const webhookUrl = config.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }
  const planned = planIngestAlerts(events, reopenedGroupIds);
  if (planned.length === 0) {
    return;
  }
  deliveries = deliveries
    .then(() => deliverProjectAlerts(webhookUrl, projectId, planned))
    .catch((error) => console.error("[alerts] delivery failed", { projectId, reason: failureName(error) }));
}
