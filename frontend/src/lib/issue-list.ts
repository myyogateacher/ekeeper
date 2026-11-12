import type { ErrorGroupSummary } from "@ekeeper/shared";
import { ageMs, localDayRange, parseServerTime } from "./time.ts";

// Pure logic behind the issues list: URL state, saved views, what goes to the API versus the browser,
// paging, merging and the sidebar counts. The page and the shell are thin readers of this module.
//
// Rule: everything the API can filter, the API filters (status, assignee, project, affected user, last
// seen range). Only what it cannot do runs in the browser (title search, severity, new in 24h, sort), and
// that runs over the whole view, loaded up to ISSUE_LIST_MAX_ROWS.

export const STATUS_VALUES = ["open", "reopened", "closed", "any"] as const;
export type StatusFilter = (typeof STATUS_VALUES)[number];

export const RANGE_PRESETS = [
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "14d", label: "Last 14 days", hours: 24 * 14 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 },
  { id: "all", label: "Any time", hours: null },
] as const;
export type RangeId = (typeof RANGE_PRESETS)[number]["id"] | "custom";

export const SORT_KEYS = ["24h", "7d", "users", "last"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SEVERITIES = ["fatal", "error", "warning", "info", "debug"] as const;

export interface ListQuery {
  status: StatusFilter;
  /** "any", "none", "assigned", "me", or a user id. */
  assignee: string;
  projectId: string | null;
  /** Affected user: id, email or username, matched by the server. */
  user: string | null;
  range: RangeId;
  /** Local days "YYYY-MM-DD", only when range is "custom". */
  from: string | null;
  to: string | null;
  q: string;
  severity: string | null;
  isNew: boolean;
  sort: SortKey;
}

export const DEFAULT_QUERY: ListQuery = {
  status: "open",
  assignee: "any",
  projectId: null,
  user: null,
  // Seven days was the list's default before this change (ErrorsPage DEFAULT_RANGE_PRESET); it is kept
  // and made visible as the Last seen chip instead of hiding older issues with no visible filter.
  range: "7d",
  from: null,
  to: null,
  q: "",
  severity: null,
  isNew: false,
  sort: "24h",
};

/** Five pages of the server maximum (ERRORS_MAX_LIMIT = 100, backend/src/routes/api.ts:442). */
export const ISSUE_LIST_PAGE_SIZE = 100;
export const ISSUE_LIST_MAX_ROWS = 500;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A malformed param falls back to its default, so it never reaches the API. */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const range = oneOf<RangeId>(params.get("range"), ["24h", "7d", "14d", "30d", "all", "custom"], DEFAULT_QUERY.range);
  const from = params.get("from");
  const to = params.get("to");
  const customOk = range === "custom" && from !== null && to !== null && DAY_PATTERN.test(from) && DAY_PATTERN.test(to);
  const assignee = params.get("assignee")?.trim() || DEFAULT_QUERY.assignee;
  const severity = params.get("severity");
  return {
    status: oneOf(params.get("status"), STATUS_VALUES, DEFAULT_QUERY.status),
    assignee,
    projectId: params.get("projectId")?.trim() || null,
    user: params.get("user")?.trim() || null,
    range: range === "custom" && !customOk ? DEFAULT_QUERY.range : range,
    // From after To (a user picking the dates in the wrong order) is swapped here, once, so the chip and the
    // API request see the same valid range. "YYYY-MM-DD" compares correctly as a string. Left as it came,
    // localDayRange rejected it and the request went out with no bounds: issues from any time under a chip
    // that still showed the dates.
    from: customOk ? (from! <= to! ? from : to) : null,
    to: customOk ? (from! <= to! ? to : from) : null,
    q: params.get("q") ?? "",
    severity: severity && (SEVERITIES as readonly string[]).includes(severity) ? severity : null,
    isNew: params.get("new") === "1",
    sort: oneOf(params.get("sort"), SORT_KEYS, DEFAULT_QUERY.sort),
  };
}

/** Defaults are omitted so a shared link stays short and two links for the same view are identical. */
export function serializeListQuery(query: ListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status !== DEFAULT_QUERY.status) params.set("status", query.status);
  if (query.assignee !== DEFAULT_QUERY.assignee) params.set("assignee", query.assignee);
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.user) params.set("user", query.user);
  if (query.range !== DEFAULT_QUERY.range) params.set("range", query.range);
  if (query.range === "custom" && query.from && query.to) {
    params.set("from", query.from);
    params.set("to", query.to);
  }
  if (query.q) params.set("q", query.q);
  if (query.severity) params.set("severity", query.severity);
  if (query.isNew) params.set("new", "1");
  if (query.sort !== DEFAULT_QUERY.sort) params.set("sort", query.sort);
  return params;
}

/**
 * The list URL after applying `patch` to the URL as it is now. Callers pass the live `location.search`, not
 * the query of the render that created them: the search box commits 200 ms after the last key, and a filter
 * changed inside that window would otherwise be written back to its old value.
 */
export function applyListPatch(search: string, patch: Partial<ListQuery>): URLSearchParams {
  return serializeListQuery({ ...parseListQuery(new URLSearchParams(search)), ...patch });
}

/**
 * Saved views are presets of status and assignee, not a param of their own, so a URL cannot carry two
 * contradicting statuses. Closed also widens the range: a closed issue is often last seen long ago.
 */
export const SAVED_VIEWS = [
  { id: "all-open", label: "All open", status: "open", assignee: "any", range: null },
  { id: "needs-triage", label: "Needs triage", status: "open", assignee: "none", range: null },
  { id: "mine", label: "Assigned to me", status: "open", assignee: "me", range: null },
  { id: "reopened", label: "Reopened", status: "reopened", assignee: "any", range: null },
  { id: "closed", label: "Closed", status: "closed", assignee: "any", range: "all" },
] as const satisfies ReadonlyArray<{ id: string; label: string; status: StatusFilter; assignee: string; range: RangeId | null }>;

export type SavedViewId = (typeof SAVED_VIEWS)[number]["id"];

/** The view's link keeps the current project, so switching views inside a project stays in it. */
export function savedViewHref(viewId: SavedViewId, projectId: string | null): string {
  const view = SAVED_VIEWS.find((entry) => entry.id === viewId)!;
  const query: ListQuery = {
    ...DEFAULT_QUERY,
    status: view.status,
    assignee: view.assignee,
    projectId,
    range: view.range ?? DEFAULT_QUERY.range,
  };
  const search = serializeListQuery(query).toString();
  return search ? `/errors?${search}` : "/errors";
}

export function matchSavedView(query: ListQuery): SavedViewId | null {
  return SAVED_VIEWS.find((view) => view.status === query.status && view.assignee === query.assignee)?.id ?? null;
}

export interface ApiFilters {
  projectId?: string;
  state: string;
  assignment: string;
  assignedUserId?: string;
  user?: string;
  from?: string;
  to?: string;
}

const STATE_FOR_STATUS: Record<StatusFilter, string> = {
  open: "open_or_reopened",
  reopened: "reopened",
  closed: "closed",
  any: "any",
};

/**
 * The server-side half of a query. `now` is passed in so the relative range is computed when the request
 * is made, not when the page rendered: a query key holding the instant would change on every render.
 */
export function toApiFilters(query: ListQuery, meId: string, now: number): ApiFilters {
  const filters: ApiFilters = { state: STATE_FOR_STATUS[query.status], assignment: "any" };
  if (query.projectId) filters.projectId = query.projectId;
  if (query.user) filters.user = query.user;
  if (query.assignee === "none") filters.assignment = "unassigned";
  else if (query.assignee === "assigned") filters.assignment = "assigned";
  else if (query.assignee !== "any") {
    filters.assignment = "user";
    filters.assignedUserId = query.assignee === "me" ? meId : query.assignee;
  }
  if (query.range === "custom" && query.from && query.to) {
    const range = localDayRange(query.from, query.to);
    if (range) {
      filters.from = range.from;
      filters.to = range.to;
    }
  } else {
    const hours = RANGE_PRESETS.find((preset) => preset.id === query.range)?.hours ?? null;
    if (hours !== null) {
      filters.from = new Date(now - hours * 3_600_000).toISOString();
    }
  }
  return filters;
}

/** Offsets of the pages still to fetch after the first, never past the cap. */
export function remainingPageOffsets(total: number): number[] {
  const offsets: number[] = [];
  for (let offset = ISSUE_LIST_PAGE_SIZE; offset < Math.min(total, ISSUE_LIST_MAX_ROWS); offset += ISSUE_LIST_PAGE_SIZE) {
    offsets.push(offset);
  }
  return offsets;
}

export interface IssueSet {
  rows: ErrorGroupSummary[];
  /** Matching issues on the server, which can exceed rows.length when the cap applies. */
  total: number;
  truncated: boolean;
  /** False when the pages disagree (see mergePages); the caller refetches once, then warns. */
  complete: boolean;
}

/**
 * Each page request re-runs the whole aggregation (backend/src/routes/api.ts:755-774), so an issue closed
 * or re-ranked between two page requests shifts the offsets and can silently drop a row. De-duplicating
 * cannot bring a skipped row back, so the set only counts as complete when every page saw the same total
 * and the unique rows add up to what that total promises.
 */
export function mergePages(pages: Array<{ errors: ErrorGroupSummary[]; total: number }>): IssueSet {
  const total = pages[0]?.total ?? 0;
  const seen = new Set<string>();
  const rows: ErrorGroupSummary[] = [];
  for (const page of pages) {
    for (const row of page.errors) {
      const key = `${row.projectId}:${row.groupId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }
  const sameTotal = pages.every((page) => page.total === total);
  const expected = Math.min(total, ISSUE_LIST_MAX_ROWS);
  return { rows, total, truncated: total > ISSUE_LIST_MAX_ROWS, complete: sameTotal && rows.length === expected };
}

export function isNewIssue(row: Pick<ErrorGroupSummary, "firstSeen">, now: number): boolean {
  const age = ageMs(row.firstSeen, now);
  return age !== null && age < 24 * 3_600_000;
}

function sortValue(row: ErrorGroupSummary, key: SortKey): number {
  if (key === "24h") return row.count24h;
  if (key === "7d") return row.count7d;
  if (key === "users") return row.affectedUsers;
  return parseServerTime(row.lastSeen)?.getTime() ?? 0;
}

/**
 * The browser-side half: search, severity, new, then a descending sort with 7 day count and last seen as
 * tie-breakers, then the server's order, so equal rows never swap places between renders.
 */
export function applyBrowserFilters(rows: ErrorGroupSummary[], query: ListQuery, now: number): ErrorGroupSummary[] {
  const needle = query.q.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (needle && !row.title.toLowerCase().includes(needle)) return false;
    if (query.severity && row.severity?.toLowerCase() !== query.severity) return false;
    if (query.isNew && !isNewIssue(row, now)) return false;
    return true;
  });
  return filtered
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        sortValue(b.row, query.sort) - sortValue(a.row, query.sort) ||
        b.row.count7d - a.row.count7d ||
        sortValue(b.row, "last") - sortValue(a.row, "last") ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

export interface ListStats {
  issues: number;
  newIn24h: number;
  needTriage: number;
  events7d: number;
}

/** Users affected is left out on purpose: distinct users cannot be summed across groups. */
export function listStats(rows: ErrorGroupSummary[], now: number): ListStats {
  return {
    issues: rows.length,
    newIn24h: rows.filter((row) => isNewIssue(row, now)).length,
    needTriage: rows.filter((row) => !row.assignedUserId && row.state !== "closed").length,
    events7d: rows.reduce((sum, row) => sum + row.count7d, 0),
  };
}

export interface ViewCounts {
  "all-open": number;
  "needs-triage": number;
  mine: number;
  reopened: number;
}

/**
 * Sidebar counts from the base set (open and reopened, 7 days, all projects), narrowed to `projectId` when set. Returns null when that set
 * is capped or inconsistent: a count taken from the 500 busiest issues can read "Assigned to me: 0" while
 * the view itself returns one, so no number is better than a wrong one.
 */
export function viewCounts(base: IssueSet, meId: string, projectId: string | null = null): ViewCounts | null {
  if (base.truncated || !base.complete) {
    return null;
  }
  // Inside a project the saved-view links keep that project, so the counts must cover only it. The base set
  // is complete here (checked above), which makes filtering it exact rather than another undercount.
  const rows = projectId ? base.rows.filter((row) => row.projectId === projectId) : base.rows;
  return {
    "all-open": rows.length,
    "needs-triage": rows.filter((row) => !row.assignedUserId).length,
    mine: rows.filter((row) => row.assignedUserId === meId).length,
    reopened: rows.filter((row) => row.state === "reopened").length,
  };
}

export function projectCounts(base: IssueSet): Map<string, number> | null {
  if (base.truncated || !base.complete) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const row of base.rows) {
    counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which empty state an empty list gets. "nothing-open" is only true when nothing narrows the list: any range
 * but "any time" can hide open issues last seen earlier, including the default 7 days, so it must not claim
 * nothing is open (PROD-10519 review: a manager whose only open issue was last seen 10 days ago saw "No open
 * issues"). "range-hides" is the case where the range is the only narrowing; "filters" is any other filter,
 * explicit custom dates included. Sort does not narrow.
 */
export function emptyListKind(query: ListQuery): "nothing-open" | "range-hides" | "filters" {
  const withoutRange = serializeListQuery({ ...query, range: DEFAULT_QUERY.range, from: null, to: null, sort: DEFAULT_QUERY.sort });
  if (withoutRange.toString() !== "" || query.range === "custom") return "filters";
  return query.range === "all" ? "nothing-open" : "range-hides";
}

export interface KeyTarget {
  key: string;
  tagName: string;
  isContentEditable: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * J, K and "/" are list shortcuts only when nothing else wants the key: never while typing in a field
 * (the search box, a date input), never with a modifier held (Cmd+K, Ctrl+J are the browser's).
 */
export function listShortcut(event: KeyTarget): "next" | "previous" | "search" | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const tag = event.tagName.toUpperCase();
  if (event.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  if (event.key === "j" || event.key === "J") return "next";
  if (event.key === "k" || event.key === "K") return "previous";
  if (event.key === "/") return "search";
  return null;
}

/** The row cursor stops at the first and last row instead of wrapping. -1 means no row focused yet. */
export function stepRow(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
