// Canonical page: the issues list is the exemplar later pages copy (see docs/frontend-architecture.md).
// Shape: all decision logic in src/lib (issue-list.ts, permissions.ts, time.ts) with tests; the page only
// reads the URL, calls the hook, and renders. State lives in the URL so back, reload and a shared link all
// restore the same list.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDown, Search, X } from "lucide-react";
import type { ErrorGroupSummary } from "@ekeeper/shared";
import { api } from "@/lib/api";
import { isApiStatus } from "@/lib/api-error";
import {
  DEFAULT_QUERY,
  RANGE_PRESETS,
  SAVED_VIEWS,
  SEVERITIES,
  applyBrowserFilters,
  isNewIssue,
  listShortcut,
  listStats,
  matchSavedView,
  parseListQuery,
  serializeListQuery,
  stepRow,
  type ListQuery,
  type SortKey,
} from "@/lib/issue-list";
import { splitTitle } from "@/lib/issue-detail";
import { canWriteProject, isAdmin } from "@/lib/permissions";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { pluralize } from "@/lib/plural";
import { formatNumber } from "@/lib/utils";
import { useMe } from "@/components/session";
import { useIssueSet } from "@/components/useIssueSet";
import { AssignMenu, initials } from "@/components/AssignMenu";
import { useIssueWorkflow } from "@/components/workflow";
import { EmptyState } from "@/components/EmptyState";
import { SeverityDot } from "@/components/Severity";

const SORT_COLUMNS: Array<{ key: SortKey; label: string; description: string }> = [
  { key: "24h", label: "24h", description: "Events in the last 24 hours" },
  { key: "7d", label: "7d", description: "Events in the last 7 days" },
  { key: "users", label: "Users", description: "Users affected" },
];

export function ErrorsPage() {
  const me = useMe();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => parseListQuery(searchParams), [searchParams]);
  const { data: set, isLoading, isError, error, isPlaceholderData, refetch } = useIssueSet(query, me.user.id);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  // Ages and "new in 24h" are measured from when the set arrived, not every render: a fresh Date.now() per
  // render would re-run the browser filter over up to 500 rows on each keystroke and hover.
  const now = useMemo(() => Date.now(), [set]);

  const update = (patch: Partial<ListQuery>, options?: { replace?: boolean }) =>
    setSearchParams(serializeListQuery({ ...query, ...patch }), { replace: options?.replace });

  const rows = useMemo(() => (set ? applyBrowserFilters(set.rows, query, now) : []), [set, query, now]);
  const stats = listStats(rows, now);
  const view = matchSavedView(query);
  const title = SAVED_VIEWS.find((entry) => entry.id === view)?.label ?? "Issues";
  const projectNames = useMemo(() => new Map((projects?.projects ?? []).map((project) => [project.id, project.name])), [projects]);
  const projectCount = projects?.projects.length;

  // Search is a local draft committed to the URL after 200 ms with replace, so typing never fights the
  // router and back does not step through every keystroke.
  const [draft, setDraft] = useState(query.q);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(query.q), [query.q]);
  useEffect(() => {
    if (draft === query.q) return;
    const timer = setTimeout(() => update({ q: draft }, { replace: true }), 200);
    return () => clearTimeout(timer);
    // update is rebuilt every render from query; draft is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const rowLinks = useRef<Array<HTMLAnchorElement | null>>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (document.querySelector("[data-popover-open]")) return;
      const action = listShortcut({
        key: event.key,
        tagName: target.tagName,
        isContentEditable: target.isContentEditable,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "search") {
        searchRef.current?.focus();
        return;
      }
      // Real DOM focus moves between row title links; Enter is the link's own activation. Nothing is
      // written to the URL, so the router never steals focus back.
      const links = rowLinks.current.slice(0, rows.length);
      const current = links.findIndex((link) => link === document.activeElement);
      const next = stepRow(current, action === "next" ? 1 : -1, links.length);
      links[next]?.focus();
      links[next]?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rows.length]);

  const filtersActive = serializeListQuery({ ...query, sort: DEFAULT_QUERY.sort }).toString() !== "";

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="page-title">{title}</h1>
        {set ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[13px] text-muted">
            <span>
              <b className="font-medium text-fg">{formatNumber(stats.issues)}</b> {pluralize(stats.issues, "issue")}
            </span>
            <button type="button" className="underline underline-offset-4 hover:text-fg max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center max-[720px]:gap-1" onClick={() => update({ isNew: true })}>
              <b className="font-medium text-fg">{stats.newIn24h}</b> new in 24h
            </button>
            {query.status !== "closed" ? (
              <Link className="underline underline-offset-4 hover:text-fg max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center max-[720px]:gap-1" to={`/errors?${serializeListQuery({ ...query, assignee: "none" })}`}>
                <b className="font-medium text-fg">{stats.needTriage}</b> need triage
              </Link>
            ) : null}
            <span>
              <b className="font-medium text-fg">{formatNumber(stats.events7d)}</b> {pluralize(stats.events7d, "event")} in 7d
            </span>
          </div>
        ) : null}
        <label className="ml-auto flex h-8 max-w-[360px] flex-[1_1_240px] items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-muted max-[720px]:ml-0 max-[720px]:h-11 max-[720px]:max-w-none max-[720px]:basis-full">
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
            }}
            placeholder="Search title or message"
            aria-label="Search issues by title or message"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted"
          />
          <span className="kbd max-[720px]:hidden">/</span>
        </label>
      </div>

      <Filters query={query} update={update} projects={projects?.projects ?? []} meId={me.user.id} />

      {set?.truncated ? (
        <p className="warn-box" role="status">
          Showing the 500 busiest of {formatNumber(set.total)} issues by events in 7 days. Search, severity and sorting apply to these.
          Narrow the project, status or range to see the rest.
        </p>
      ) : null}
      {set && !set.complete ? (
        <p className="warn-box" role="status">
          The list changed while loading, so an issue may be missing.{" "}
          <button type="button" className="font-medium underline" onClick={() => void refetch()}>
            Refresh
          </button>
        </p>
      ) : null}

      <section className={`card issue-table ${isPlaceholderData ? "opacity-60" : ""}`} aria-busy={isLoading || isPlaceholderData}>
        <div className="issue-grid h-9 border-b border-line text-xs font-medium text-muted max-[720px]:hidden" role="row">
          <span>Issue</span>
          {SORT_COLUMNS.map((column) => (
            <SortHeader key={column.key} column={column} active={query.sort === column.key} onSort={() => update({ sort: column.key })} />
          ))}
          <span className="col-wide">Owner</span>
          <SortHeader
            column={{ key: "last", label: "Last seen", description: "Last seen" }}
            active={query.sort === "last"}
            onSort={() => update({ sort: "last" })}
            alignStart
          />
        </div>

        {isLoading ? (
          <Skeleton />
        ) : isError ? (
          isApiStatus(error, 403) ? (
            <EmptyState title="You don't have access to this project" action={<Link className="btn" to="/errors">Clear filters</Link>} />
          ) : (
            <EmptyState title="Couldn't load issues" action={<button type="button" className="btn" onClick={() => void refetch()}>Try again</button>}>
              The server didn't respond. Your filters are kept.
            </EmptyState>
          )
        ) : projectCount === 0 ? (
          isAdmin(me) ? (
            <EmptyState title="Connect your first app" action={<Link className="btn btn-primary" to="/settings/projects">New project</Link>}>
              Create a project, then point the Sentry SDK at its DSN to start receiving errors.
            </EmptyState>
          ) : (
            <EmptyState title="No projects yet">You don't have access to any project yet. Ask an admin to add you.</EmptyState>
          )
        ) : rows.length === 0 ? (
          // Any non-default param means "nothing matches", including search or severity on the default
          // view; only the bare default view can truthfully say nothing is open.
          filtersActive ? (
            <EmptyState title="No issues match these filters" action={<Link className="btn" to="/errors">Clear filters</Link>} />
          ) : (
            <EmptyState title="No open issues" action={<Link className="btn" to="/errors?status=closed&range=all">View closed issues</Link>}>
              Closed issues reopen on their own if the error happens again.
            </EmptyState>
          )
        ) : (
          <ul className="m-0 list-none p-0">
            {rows.map((row, index) => (
              <IssueRow
                key={`${row.projectId}:${row.groupId}`}
                row={row}
                now={now}
                projectName={projectNames.get(row.projectId) ?? row.projectId}
                canWrite={canWriteProject(me, row.projectId)}
                meId={me.user.id}
                linkRef={(element) => {
                  rowLinks.current[index] = element;
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="flex flex-wrap gap-4 text-xs text-muted max-[720px]:hidden">
        <span>
          <span className="kbd">J</span> <span className="kbd">K</span> move
        </span>
        <span>
          <span className="kbd">Enter</span> open
        </span>
        <span>
          <span className="kbd">/</span> search
        </span>
      </p>
    </div>
  );
}

function SortHeader({
  column,
  active,
  onSort,
  alignStart,
}: {
  column: { key: SortKey; label: string; description: string };
  active: boolean;
  onSort: () => void;
  alignStart?: boolean;
}) {
  return (
    <span className={`${column.key === "24h" ? "" : "col-wide"} ${alignStart ? "" : "justify-self-end"}`} aria-sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={onSort}
        aria-label={`Sort by ${column.description.toLowerCase()}`}
        className={`inline-flex items-center gap-1 ${active ? "text-fg" : "hover:text-fg"}`}
      >
        {column.label}
        {active ? <ArrowDown className="h-3.5 w-3.5" aria-hidden /> : null}
      </button>
    </span>
  );
}

function IssueRow({
  row,
  now,
  projectName,
  canWrite,
  meId,
  linkRef,
}: {
  row: ErrorGroupSummary;
  now: number;
  projectName: string;
  canWrite: boolean;
  meId: string;
  linkRef: (element: HTMLAnchorElement | null) => void;
}) {
  const workflow = useIssueWorkflow();
  const [type, message] = splitTitle(row.title);
  const level = (row.severity || "error").toLowerCase();

  return (
    <li className="issue-grid group relative min-h-[52px] border-b border-line last:border-b-0 hover:bg-raised focus-within:bg-raised">
      <div className="relative flex min-w-0 flex-col gap-0.5 py-2 max-[720px]:pb-2 max-[720px]:pt-0">
        <div className="issue-line flex min-w-0 items-center gap-2">
          <SeverityDot level={level} className="issue-dot" />
          <Link
            ref={linkRef}
            to={`/errors/${row.projectId}/${row.groupId}`}
            className="issue-title block min-w-0 text-fg hover:text-accent focus-visible:outline-none"
          >
            {/* The text sits in its own span so the two line clamp clips the span, not the link: the link's
                vertical padding (the 44px phone target) is inside its overflow box, so clamping the link
                itself let a third line show through the padding. */}
            <span className="issue-title-text block truncate">
              <b className="font-semibold">{type}</b>
              {message ? `: ${message}` : ""}
            </span>
          </Link>
          {row.state === "reopened" ? <span className="tag bg-reopened/10 text-reopened">Reopened</span> : null}
          {isNewIssue(row, now) ? <span className="tag text-accent ring-1 ring-inset ring-accent">New</span> : null}
          {canWrite && row.state !== "closed" ? (
            <span className="absolute right-0 top-2 hidden bg-raised pl-3 group-focus-within:flex group-hover:flex max-[720px]:!hidden">
              <button
                type="button"
                className="btn btn-sm"
                disabled={workflow.isPending}
                onClick={() =>
                  workflow.mutate({ projectId: row.projectId, groupId: row.groupId, payload: { state: "closed" }, previousState: row.state })
                }
              >
                Close
              </button>
            </span>
          ) : null}
        </div>
        <div className="issue-meta flex flex-wrap items-center gap-x-1.5 pl-4 text-xs leading-4 text-muted">
          <span className="text-fg">{projectName}</span>
          <span aria-hidden className="issue-sep">·</span>
          <span>{level}</span>
          <span aria-hidden className="issue-sep">·</span>
          <span title={formatAbsolute(row.firstSeen)}>first seen {formatRelative(row.firstSeen, now)}</span>
          {row.githubIssueUrl ? (
            <>
              <span aria-hidden className="issue-sep">·</span>
              <a className="underline max-[720px]:inline-flex max-[720px]:min-h-11 max-[720px]:items-center" href={row.githubIssueUrl} target="_blank" rel="noreferrer">
                GitHub #{row.githubIssueNumber}
              </a>
            </>
          ) : null}
        </div>
      </div>
      <span className="text-right tabular-nums">
        <b className="font-semibold">{formatNumber(row.count24h)}</b>
        <span className="unit text-xs text-muted"> in 24h</span>
      </span>
      <span className="col-wide text-right tabular-nums text-muted">{formatNumber(row.count7d)}</span>
      <span className="col-wide text-right tabular-nums text-muted">{formatNumber(row.affectedUsers)}</span>
      <span>
        {canWrite ? (
          <AssignMenu
            variant="avatar"
            projectId={row.projectId}
            groupId={row.groupId}
            meId={meId}
            assignedUserId={row.assignedUserId}
            assignedUserName={row.assignedUserName}
          />
        ) : (
          <span
            title={row.assignedUserName ?? "Unassigned"}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-[11px] font-semibold text-muted"
          >
            {row.assignedUserName ? initials(row.assignedUserName) : "-"}
          </span>
        )}
      </span>
      <span className="col-wide text-[13px] text-muted" title={formatAbsolute(row.lastSeen)}>
        {formatRelative(row.lastSeen, now)}
      </span>
    </li>
  );
}

function Filters({
  query,
  update,
  projects,
  meId,
}: {
  query: ListQuery;
  update: (patch: Partial<ListQuery>, options?: { replace?: boolean }) => void;
  projects: Array<{ id: string; name: string }>;
  meId: string;
}) {
  const { data: assignees } = useQuery({
    queryKey: ["error-assignees", query.projectId ?? "all"],
    queryFn: () => api.errorAssignees(query.projectId ?? undefined),
  });
  const [userDraft, setUserDraft] = useState(query.user ?? "");
  useEffect(() => setUserDraft(query.user ?? ""), [query.user]);

  return (
    <div className="flex flex-wrap items-center gap-2 max-[720px]:flex-nowrap max-[720px]:overflow-x-auto">
      <ChipSelect
        label="Status"
        value={query.status}
        onChange={(value) => update({ status: value as ListQuery["status"] })}
        options={[
          ["open", "Open, Reopened"],
          ["reopened", "Reopened"],
          ["closed", "Closed"],
          ["any", "Any"],
        ]}
        isDefault={query.status === DEFAULT_QUERY.status}
      />
      <ChipSelect
        label="Project"
        value={query.projectId ?? ""}
        onChange={(value) => update({ projectId: value || null })}
        options={[["", "All"], ...projects.map((project): [string, string] => [project.id, project.name])]}
        isDefault={!query.projectId}
      />
      <ChipSelect
        label="Assignee"
        value={query.assignee}
        onChange={(value) => update({ assignee: value })}
        options={[
          ["any", "Any"],
          ["none", "Unassigned"],
          ["assigned", "Assigned"],
          ["me", "Me"],
          ...(assignees?.users ?? []).filter((user) => user.id !== meId).map((user): [string, string] => [user.id, user.name]),
        ]}
        isDefault={query.assignee === "any"}
      />
      <ChipSelect
        label="Severity"
        value={query.severity ?? ""}
        onChange={(value) => update({ severity: value || null })}
        options={[["", "Any"], ...SEVERITIES.map((level): [string, string] => [level, level])]}
        isDefault={!query.severity}
      />
      <ChipSelect
        label="Last seen"
        value={query.range}
        onChange={(value) => {
          if (value === "custom") {
            const today = localDay(new Date());
            update({ range: "custom", from: query.from ?? today, to: query.to ?? today });
          } else {
            update({ range: value as ListQuery["range"], from: null, to: null });
          }
        }}
        options={[...RANGE_PRESETS.map((preset): [string, string] => [preset.id, preset.label]), ["custom", "Custom dates"]]}
        isDefault={query.range === DEFAULT_QUERY.range}
      />
      {query.range === "custom" ? (
        <span className="chip border-solid">
          <label className="sr-only" htmlFor="range-from">From</label>
          <input
            id="range-from"
            type="date"
            className="bg-transparent text-xs text-fg max-[720px]:-my-px max-[720px]:self-stretch"
            value={query.from ?? ""}
            onChange={(event) => event.target.value && update({ from: event.target.value })}
          />
          <span aria-hidden>to</span>
          <label className="sr-only" htmlFor="range-to">To</label>
          <input
            id="range-to"
            type="date"
            className="bg-transparent text-xs text-fg max-[720px]:-my-px max-[720px]:self-stretch"
            value={query.to ?? ""}
            onChange={(event) => event.target.value && update({ to: event.target.value })}
          />
        </span>
      ) : null}
      <form
        className={`chip ${query.user ? "border-solid bg-raised" : "border-dashed"}`}
        onSubmit={(event) => {
          event.preventDefault();
          update({ user: userDraft.trim() || null });
        }}
      >
        <label htmlFor="affected-user">Affected user</label>
        <input
          id="affected-user"
          value={userDraft}
          onChange={(event) => setUserDraft(event.target.value)}
          onBlur={() => userDraft.trim() !== (query.user ?? "") && update({ user: userDraft.trim() || null })}
          placeholder="id, email or username"
          className="w-36 bg-transparent text-xs text-fg outline-none placeholder:text-muted max-[720px]:-my-px max-[720px]:self-stretch"
        />
        {query.user ? (
          <button type="button" aria-label="Clear affected user filter" className="max-[720px]:-my-px max-[720px]:inline-flex max-[720px]:w-11 max-[720px]:items-center max-[720px]:justify-center max-[720px]:self-stretch" onClick={() => update({ user: null })}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </form>
      <button
        type="button"
        aria-pressed={query.isNew}
        className={`chip ${query.isNew ? "border-solid bg-raised text-fg" : "border-dashed"}`}
        onClick={() => update({ isNew: !query.isNew })}
      >
        New in 24h
      </button>
    </div>
  );
}

function ChipSelect({
  label,
  value,
  onChange,
  options,
  isDefault,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  isDefault: boolean;
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <span className={`chip ${isDefault ? "" : "bg-raised"}`}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="cursor-pointer bg-transparent font-medium capitalize text-fg outline-none max-[720px]:-my-px max-[720px]:self-stretch"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </span>
  );
}

function Skeleton() {
  return (
    <div aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="issue-grid h-[52px] border-b border-line last:border-b-0">
          <div className="flex flex-col gap-2">
            <span className="h-2.5 w-3/5 rounded bg-raised" />
            <span className="h-2 w-1/4 rounded bg-raised" />
          </div>
          <span className="h-2.5 rounded bg-raised" />
          <span className="col-wide h-2.5 rounded bg-raised" />
          <span className="col-wide h-2.5 rounded bg-raised" />
          <span className="h-6 w-6 rounded-full bg-raised" />
          <span className="col-wide h-2.5 rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
