// Issue detail. Follows the shape of ErrorsPage.tsx (the canonical page): rules live in lib/issue-detail.ts
// with tests, the selected event lives in the URL (?event=), and writes go through useIssueWorkflow.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ChevronLeft, Download, Link as LinkIcon } from "lucide-react";
import type { ErrorEventDetail } from "@ekeeper/shared";
import { api } from "@/lib/api";
import { isApiStatus } from "@/lib/api-error";
import {
  BREADCRUMB_PREVIEW,
  breadcrumbOffset,
  breadcrumbPreview,
  displayText,
  eventLevel,
  eventNav,
  exceptionParts,
  framesCrashFirst,
  occurrenceStats,
  parseJsonStructure,
  parseMaybeJson,
} from "@/lib/issue-detail";
import { canWriteProject } from "@/lib/permissions";
import { formatAbsolute, formatDayTime, formatRelative } from "@/lib/time";
import { pluralize } from "@/lib/plural";
import { idsFromIssuePath, issuePath } from "@/lib/url";
import { formatNumber } from "@/lib/utils";
import { useMe } from "@/components/session";
import { AssignMenu } from "@/components/AssignMenu";
import { StatusControl } from "@/components/StatusControl";
import { useIssueWorkflow } from "@/components/workflow";
import { EmptyState } from "@/components/EmptyState";
import { SeverityDot } from "@/components/Severity";
import { copyText } from "@/components/clipboard";

type UnknownRecord = Record<string, unknown>;

const STATE_TAG: Record<string, string> = {
  open: "bg-open/10 text-open",
  reopened: "bg-reopened/10 text-reopened",
  closed: "bg-closed/10 text-closed",
};

export function ErrorDetailPage() {
  const me = useMe();
  // The ids come from the raw pathname, decoded once, not from useParams: the router decodes a %2F in a param
  // twice, so an id with a literal "%2F" in it opened as "isn't available". An unreadable pathname leaves both
  // empty, which disables the query and shows the same "isn't available" state.
  const { pathname } = useLocation();
  const { projectId, groupId } = idsFromIssuePath(pathname) ?? { projectId: "", groupId: "" };
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get("event") ?? undefined;
  // placeholderData keeps the previous event of this issue on screen while the next one loads, so the page
  // does not flash a skeleton on every Older click.
  const { data, isLoading, isError, error, isPlaceholderData, refetch } = useQuery({
    queryKey: ["error-detail", projectId, groupId, eventId],
    queryFn: () => api.errorDetail(projectId, groupId, eventId),
    enabled: Boolean(projectId && groupId),
    // Only an event switch inside the same issue keeps the previous data. Across issues (a similar-issue
    // link, back to another group) it showed the old issue under the new URL with live Close and Older, so a
    // Close in that window sent the old group's id (queryKey is ["error-detail", project, group, event]).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === projectId && previousQuery?.queryKey[2] === groupId ? previous : undefined,
  });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const now = useMemo(() => Date.now(), [data]);

  const back = (
    <Link to="/errors" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg max-[720px]:min-h-11">
      <ChevronLeft className="h-4 w-4" aria-hidden /> Issues
    </Link>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        {back}
        <div className="h-7 w-2/3 rounded bg-raised" />
        <div className="card h-40" />
        <div className="card h-80" />
      </div>
    );
  }
  // An unknown group answers 200 with error: null, a project the viewer cannot read answers 403
  // (backend/src/routes/api.ts:831): both read the same, so the page never confirms an issue exists.
  if ((isError && isApiStatus(error, 403, 404)) || (!isError && !data?.error)) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div className="card">
          <EmptyState title="This issue isn't available" action={<Link className="btn" to="/errors">Back to issues</Link>}>
            It may have been removed, or you may not have access to its project.
          </EmptyState>
        </div>
      </div>
    );
  }
  if (isError || !data?.error) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div className="card">
          <EmptyState title="Couldn't load this issue" action={<button type="button" className="btn" onClick={() => void refetch()}>Try again</button>} />
        </div>
      </div>
    );
  }

  const event = data.error;
  const projectName = projects?.projects.find((project) => project.id === projectId)?.name ?? projectId;
  const selectEvent = (id: string | null) => {
    if (!id) return;
    const next = new URLSearchParams(searchParams);
    next.set("event", id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className={`flex flex-col gap-4 ${isPlaceholderData ? "opacity-70" : ""}`}>
      {back}
      <Header event={event} projectId={projectId} projectName={projectName} canWrite={canWriteProject(me, projectId)} meId={me.user.id} loading={isPlaceholderData} />
      <Stats occurrences={data.occurrences} now={now} />
      <EventBar event={event} projectId={projectId} occurrences={data.occurrences} onSelect={selectEvent} />
      <div className="grid min-w-0 gap-4 [grid-template-columns:minmax(0,1fr)_300px] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <StackTrace event={event} />
          <Breadcrumbs event={event} />
        </div>
        <Rail event={event} similar={data.duplicateGroups} projectId={projectId} />
      </div>
    </div>
  );
}

function Header({
  event,
  projectId,
  projectName,
  canWrite,
  meId,
  loading,
}: {
  event: ErrorEventDetail;
  projectId: string;
  projectName: string;
  canWrite: boolean;
  meId: string;
  /** The next event of this issue is loading and the previous one is still shown: writes wait for it. */
  loading: boolean;
}) {
  const workflow = useIssueWorkflow();
  // Same "<type>: <message>" the list shows, built from the parts ingest built the title from (ingest.ts:191).
  const titleType = exceptionParts(event.exception).type;
  const titleMessage = event.message;
  const level = eventLevel(event.rawPayload);
  const change = (state: typeof event.state) =>
    workflow.mutate({ projectId, groupId: event.groupId, payload: { state }, previousState: event.state });

  return (
    <header className="flex flex-col gap-2.5">
      <h1 className="page-title break-words">
        <span className="font-semibold">{titleType}</span>
        {titleMessage ? <span className="font-normal">: {titleMessage}</span> : null}
      </h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted">
        <span className={`tag ${level === "fatal" ? "bg-fatal/10 text-fatal" : "bg-raised text-fg"}`}>
          <SeverityDot level={level} />
          <span className="ml-1.5">{level}</span>
        </span>
        <span className={`tag capitalize ${STATE_TAG[event.state] ?? ""}`}>{event.state}</span>
        <span className="text-fg">{projectName}</span>
        {event.githubIssueUrl ? (
          <a className="underline underline-offset-4 hover:text-fg max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center" href={event.githubIssueUrl} target="_blank" rel="noreferrer">
            GitHub #{event.githubIssueNumber}
          </a>
        ) : (
          <span>Not on GitHub yet</span>
        )}
        {event.state === "closed" ? <span>Reopens on its own if a new event arrives.</span> : null}
        <span className="ml-auto flex flex-wrap items-center gap-2 max-[720px]:ml-0">
          {canWrite ? (
            <>
              <AssignMenu
                variant="button"
                projectId={projectId}
                groupId={event.groupId}
                meId={meId}
                assignedUserId={event.assignedUserId}
                assignedUserName={event.assignedUserName}
                disabled={loading}
              />
              <StatusControl state={event.state} pending={workflow.isPending || loading} onChange={change} />
            </>
          ) : (
            <span>Owner: {event.assignedUserName ?? "nobody"}</span>
          )}
        </span>
      </div>
    </header>
  );
}

function Stats({ occurrences, now }: { occurrences: Array<{ eventId: string; timestamp: string }>; now: number }) {
  const stats = occurrenceStats(occurrences, now);
  const peak = Math.max(0, ...stats.hourly);
  return (
    <section className="card overflow-hidden" aria-label="Issue stats">
      <div className="grid gap-px border-b border-line bg-line [grid-template-columns:repeat(4,minmax(0,1fr))] max-[860px]:[grid-template-columns:repeat(2,minmax(0,1fr))]">
        <Stat label="Last 24h" value={formatNumber(stats.count24h)} />
        <Stat label="Last 7 days" value={formatNumber(stats.count7d)} />
        <Stat label="First seen" value={formatRelative(stats.firstSeen, now)} detail={formatAbsolute(stats.firstSeen)} />
        <Stat label="Last seen" value={formatRelative(stats.lastSeen, now)} detail={formatAbsolute(stats.lastSeen)} />
      </div>
      <div className="px-4 pb-2.5 pt-3">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted">
          <span>Events per hour, last 24h</span>
          <span>{peak > 0 ? `Peak ${formatNumber(peak)} per hour` : "No events in the last 24 hours"}</span>
        </div>
        <div
          className="mt-2 flex h-14 items-end gap-[3px] border-b border-line"
          role="img"
          aria-label={`Events per hour over the last 24 hours, ${peak > 0 ? `peak ${peak}` : "none"}`}
        >
          {stats.hourly.map((count, index) => (
            <span
              key={index}
              title={`${count} ${pluralize(count, "event")}, ${23 - index}h ago`}
              className={`min-w-[2px] flex-1 rounded-t-sm ${count ? "bg-muted" : "bg-line"}`}
              style={{ height: `${count ? Math.max(8, (count / peak) * 100) : 4}%` }}
            />
          ))}
        </div>
        {/* The first bar starts 24 hours before now: occurrenceStats buckets by whole hours counted back from now. */}
        <div className="mt-1 flex justify-between text-[11px] text-muted">
          <span>{formatDayTime(now - 24 * 3_600_000)}</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface px-4 py-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {detail ? <span className="text-xs text-muted">{detail}</span> : null}
    </div>
  );
}

function EventBar({
  event,
  projectId,
  occurrences,
  onSelect,
}: {
  event: ErrorEventDetail;
  projectId: string;
  occurrences: Array<{ eventId: string; timestamp: string }>;
  onSelect: (eventId: string | null) => void;
}) {
  const nav = eventNav(occurrences, event.eventId);
  const download = () => {
    const blob = new Blob([JSON.stringify(parseMaybeJson(event.rawPayload, {}), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `event-${event.eventId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  // The page's own encoded path, not ids re-assembled into one: the ids in the route were decoded by the
  // router, and the pathname the browser is already on is the form that provably opens this issue.
  const eventUrl = `${window.location.origin}${window.location.pathname}?${new URLSearchParams({ event: event.eventId })}`;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-muted">
        Event {nav.index >= 0 ? formatNumber(nav.index + 1) : "?"} of {formatNumber(nav.total)}
        <span aria-hidden> · </span>
        {formatAbsolute(event.timestamp)}
      </span>
      <span className="flex gap-1">
        {(
          [
            ["Latest", nav.latest],
            ["Newer", nav.newer],
            ["Older", nav.older],
            ["Oldest", nav.oldest],
          ] as const
        ).map(([label, target]) => (
          <button key={label} type="button" className="btn btn-sm" disabled={!target} onClick={() => onSelect(target)}>
            {label}
          </button>
        ))}
      </span>
      <span className="ml-auto flex gap-1 max-[720px]:ml-0">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copyText(eventUrl, "Link copied")}>
          <LinkIcon className="h-3.5 w-3.5" aria-hidden /> Copy link
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={download}>
          <Download className="h-3.5 w-3.5" aria-hidden /> Raw event
        </button>
      </span>
    </div>
  );
}

function StackTrace({ event }: { event: ErrorEventDetail }) {
  const frames = framesCrashFirst(event.stacktrace, event.exception);
  return (
    <section className="card" aria-labelledby="stacktrace-title">
      <div className="card-head">
        <h2 id="stacktrace-title" className="m-0 text-sm font-semibold">Stack trace</h2>
        <span className="text-xs text-muted">crash site first</span>
        {event.sourceMapApplied ? <span className="ml-auto text-xs text-muted">Source mapped, release {event.sourceMapRelease ?? "unknown"}</span> : null}
      </div>
      {!event.sourceMapApplied && frames.length > 0 ? (
        <p className="warn-box m-3">
          No source map matched this event, so frames show the minified file and position. Upload source maps for this release in Settings.
        </p>
      ) : null}
      {frames.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">This event has no stack trace.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {frames.map((frame, index) => (
            <li key={index} className={`flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line px-4 py-2 last:border-b-0 ${index === 0 ? "bg-raised" : ""}`}>
              <span className="mono min-w-0 break-all font-semibold">{displayText(frame.function) || "?"}</span>
              <span className="mono min-w-0 flex-1 break-all text-muted">
                {displayText(frame.filename) || "unknown file"}
                {frame.lineno !== undefined ? `:${displayText(frame.lineno)}` : ""}
                {frame.colno !== undefined ? `:${displayText(frame.colno)}` : ""}
              </span>
              {frame.deobfuscated ? <span className="tag bg-closed/10 text-closed">mapped</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Breadcrumbs({ event }: { event: ErrorEventDetail }) {
  const [showAll, setShowAll] = useState(false);
  const crumbs = breadcrumbPreview(event.breadcrumbs, showAll);
  return (
    <section className="card" aria-labelledby="breadcrumbs-title">
      <div className="card-head">
        <h2 id="breadcrumbs-title" className="m-0 text-sm font-semibold">Breadcrumbs</h2>
        <span className="text-xs text-muted">oldest first, ending at the error</span>
        {event.breadcrumbs.length > BREADCRUMB_PREVIEW ? (
          <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => setShowAll((value) => !value)}>
            {showAll ? `Show last ${BREADCRUMB_PREVIEW}` : `Show all ${event.breadcrumbs.length}`}
          </button>
        ) : null}
      </div>
      {crumbs.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted">No breadcrumbs captured.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {crumbs.map((crumb, index) => (
            <li key={index} className="grid gap-x-3 border-b border-line px-4 py-2 text-[13px] last:border-b-0 [grid-template-columns:64px_104px_minmax(0,1fr)_auto] max-[720px]:[grid-template-columns:64px_minmax(0,1fr)_auto]">
              <span className="mono text-muted" title={formatAbsolute(crumb.timestamp)}>
                {breadcrumbOffset(crumb.timestamp, event.timestamp) ?? ""}
              </span>
              <span className="text-muted max-[720px]:hidden">{crumb.category}</span>
              <span className="min-w-0 break-words">
                <span className="hidden text-muted max-[720px]:inline">{crumb.category} </span>
                {crumb.message || (Object.keys(crumb.data ?? {}).length ? <code className="mono text-muted">{formatValue(crumb.data)}</code> : "")}
              </span>
              <span className="text-xs text-muted">{crumb.level}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Rail({
  event,
  similar,
  projectId,
}: {
  event: ErrorEventDetail;
  similar: Array<{ groupId: string; message: string; events: number; lastSeen: string }>;
  projectId: string;
}) {
  const raw = parseMaybeJson<UnknownRecord>(event.rawPayload, {});
  const user = parseMaybeJson<UnknownRecord>(raw.user, {});
  const request = parseMaybeJson<UnknownRecord>(raw.request, {});
  const extra = parseMaybeJson<UnknownRecord>(raw.extra, {});
  const tags = Object.keys(parseMaybeJson<UnknownRecord>(raw.tags, {})).length ? parseMaybeJson<UnknownRecord>(raw.tags, {}) : event.tags;
  const contexts = Object.fromEntries(Object.entries(event.contexts ?? {}).filter(([key]) => key !== "trace"));
  // The list's affected user filter matches id, email or username (ErrorsPage `user` param), so any one links.
  const userKey = displayText(user.id) || displayText(user.email) || displayText(user.username);

  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <RailCard title="User">
        {Object.keys(user).length ? (
          <>
            <KeyValues record={user} />
            {userKey ? (
              <Link className="mt-2 inline-block text-[13px] text-accent underline underline-offset-4 max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center" to={`/errors?user=${encodeURIComponent(userKey)}&range=all`}>
                Other issues for this user
              </Link>
            ) : null}
          </>
        ) : (
          <p className="m-0 text-[13px] text-muted">No user captured.</p>
        )}
      </RailCard>
      <RailCard title="Runtime">
        <KeyValues record={{ Browser: event.browser, Device: event.device, OS: event.os, Runtime: event.runtime, URL: request.url }} />
      </RailCard>
      <RailCard title="Tags">
        {Object.keys(tags).length ? <KeyValues record={tags} /> : <p className="m-0 text-[13px] text-muted">No tags.</p>}
      </RailCard>
      {similar.length ? (
        <RailCard title="Similar issues">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {similar.map((group) => {
              const href = issuePath(projectId, group.groupId);
              return (
                <li key={group.groupId} className="text-[13px]">
                  {href ? (
                    <Link className="block break-words hover:text-accent max-[720px]:min-h-11" to={href}>
                      {group.message}
                    </Link>
                  ) : (
                    <span className="block break-words">{group.message}</span>
                  )}
                  <span className="text-xs text-muted">
                    {formatNumber(group.events)} {pluralize(group.events, "event")} · last {formatRelative(group.lastSeen, Date.now())}
                  </span>
                </li>
              );
            })}
          </ul>
        </RailCard>
      ) : null}
      <Collapsible title="Contexts" record={contexts} />
      <Collapsible title="Extra" record={extra} />
      <Collapsible title="Request headers" record={parseMaybeJson<UnknownRecord>(request.headers, {})} />
    </aside>
  );
}

function RailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="m-0 mb-2.5 text-xs font-semibold text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Collapsible({ title, record }: { title: string; record: UnknownRecord }) {
  if (!Object.keys(record).length) return null;
  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-xs font-semibold text-muted max-[720px]:-m-4 max-[720px]:block max-[720px]:p-4">{title}</summary>
      <div className="mt-2.5">
        <KeyValues record={record} />
      </div>
    </details>
  );
}

function KeyValues({ record }: { record: UnknownRecord }) {
  const entries = Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!entries.length) return <p className="m-0 text-[13px] text-muted">Unknown</p>;
  return (
    <dl className="m-0 grid gap-x-3 gap-y-1.5 text-[13px] [grid-template-columns:minmax(0,auto)_minmax(0,1fr)]">
      {entries.map(([key, value]) => {
        const shown = formatValue(value);
        return (
          <div key={key} className="contents">
            <dt className="break-all text-muted">{key}</dt>
            <dd className="m-0 min-w-0 break-all">
              {shown.includes("\n") ? <pre className="mono m-0 whitespace-pre-wrap">{shown}</pre> : shown}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * SDK payloads nest JSON as text inside JSON; text that parses to an object or array is pretty printed. Any
 * other text, including "1" or "null", is shown as sent rather than as its parsed scalar.
 */
function formatValue(value: unknown): string {
  const structure = typeof value === "string" ? parseJsonStructure(value) : value;
  return structure !== null && typeof structure === "object" ? JSON.stringify(structure, null, 2) : String(value);
}
