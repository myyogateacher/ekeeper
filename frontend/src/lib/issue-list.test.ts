import { test } from "node:test";
import assert from "node:assert/strict";
import type { ErrorGroupSummary } from "@ekeeper/shared";
import {
  DEFAULT_QUERY,
  ISSUE_LIST_MAX_ROWS,
  SAVED_VIEWS,
  applyBrowserFilters,
  listShortcut,
  matchSavedView,
  mergePages,
  parseListQuery,
  remainingPageOffsets,
  savedViewHref,
  serializeListQuery,
  stepRow,
  toApiFilters,
  viewCounts,
} from "./issue-list.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");

function row(id: string, overrides: Partial<ErrorGroupSummary> = {}): ErrorGroupSummary {
  return {
    groupId: id,
    projectId: "p1",
    title: `TypeError: thing ${id}`,
    fingerprint: id,
    count7d: 10,
    count24h: 1,
    firstSeen: "2026-11-01 00:00:00.000",
    lastSeen: "2026-11-12 11:00:00.000",
    severity: "error",
    affectedUsers: 1,
    state: "open",
    assignedUserId: null,
    assignedUserName: null,
    githubIssueNumber: null,
    githubIssueUrl: null,
    ...overrides,
  };
}

test("a URL survives parse then serialise unchanged, and defaults are omitted", () => {
  const search = "status=closed&assignee=me&projectId=p1&user=u%40x.test&range=custom&from=2026-11-01&to=2026-11-02&q=zoom&severity=fatal&new=1&sort=users";
  assert.equal(serializeListQuery(parseListQuery(new URLSearchParams(search))).toString(), search);
  assert.equal(serializeListQuery(DEFAULT_QUERY).toString(), "");
});

test("a malformed param falls back to its default and never reaches the API", () => {
  const query = parseListQuery(new URLSearchParams("status=bogus&range=custom&from=yesterday&to=2026-11-02&severity=loud&sort=random"));
  assert.equal(query.status, "open");
  assert.equal(query.range, "7d");
  assert.equal(query.from, null);
  assert.equal(query.severity, null);
  assert.equal(query.sort, "24h");
  const filters = toApiFilters(query, "me-id", NOW);
  assert.equal(filters.state, "open_or_reopened");
  assert.equal(filters.to, undefined);
});

test("every saved view link parses back to that same view, inside or outside a project", () => {
  for (const view of SAVED_VIEWS) {
    for (const projectId of [null, "p1"]) {
      const href = savedViewHref(view.id, projectId);
      const query = parseListQuery(new URLSearchParams(href.split("?")[1] ?? ""));
      assert.equal(matchSavedView(query), view.id, href);
      assert.equal(query.projectId, projectId, href);
    }
  }
});

test("everything the API can filter is sent to it; search, severity, new and sort never are", () => {
  const query = { ...DEFAULT_QUERY, assignee: "me", projectId: "p1", user: "u1", q: "zoom", severity: "fatal", isNew: true, sort: "users" as const };
  const filters = toApiFilters(query, "me-id", NOW);
  assert.deepEqual(filters, {
    state: "open_or_reopened",
    assignment: "user",
    assignedUserId: "me-id",
    projectId: "p1",
    user: "u1",
    from: new Date(NOW - 7 * 86_400_000).toISOString(),
  });
});

test("the page plan never requests more than the row cap", () => {
  assert.deepEqual(remainingPageOffsets(50), []);
  assert.deepEqual(remainingPageOffsets(260), [100, 200]);
  assert.deepEqual(remainingPageOffsets(10_000), [100, 200, 300, 400]);
  assert.equal(Math.max(...remainingPageOffsets(10_000)) + 100, ISSUE_LIST_MAX_ROWS);
});

// The outside review's case: page 1 is fetched, then an issue closes, so page 2 starts one row later and
// the old row 101 is never seen. The totals disagree, which is the only trace the skip leaves.
test("a page set whose totals disagree, or whose unique rows fall short of the total, is never complete", () => {
  const page1 = { total: 200, errors: Array.from({ length: 100 }, (_, i) => row(`g${i + 1}`)) };
  const shifted = { total: 199, errors: Array.from({ length: 99 }, (_, i) => row(`g${i + 102}`)) };
  assert.equal(mergePages([page1, shifted]).complete, false);

  const moved = { total: 200, errors: [row("g100"), ...Array.from({ length: 99 }, (_, i) => row(`g${i + 102}`))] };
  const merged = mergePages([page1, moved]);
  assert.equal(merged.rows.length, 199);
  assert.equal(merged.complete, false);

  const clean = { total: 200, errors: Array.from({ length: 100 }, (_, i) => row(`g${i + 101}`)) };
  assert.equal(mergePages([page1, clean]).complete, true);
});

test("merged pages hold no duplicate row when a row moves between pages", () => {
  const merged = mergePages([
    { total: 3, errors: [row("a"), row("b")] },
    { total: 3, errors: [row("b"), row("c")] },
  ]);
  assert.deepEqual(merged.rows.map((entry) => entry.groupId), ["a", "b", "c"]);
});

test("search matches the title without regard to case, and empty search matches everything", () => {
  const rows = [row("a", { title: "TypeError: Zoom SDK init" }), row("b", { title: "ChunkLoadError" })];
  assert.deepEqual(applyBrowserFilters(rows, { ...DEFAULT_QUERY, q: "zoom sdk" }, NOW).map((entry) => entry.groupId), ["a"]);
  assert.equal(applyBrowserFilters(rows, DEFAULT_QUERY, NOW).length, 2);
});

test("severity and new filter in the browser", () => {
  const rows = [
    row("old-fatal", { severity: "fatal" }),
    row("new-error", { firstSeen: "2026-11-12 03:00:00.000" }),
  ];
  assert.deepEqual(applyBrowserFilters(rows, { ...DEFAULT_QUERY, severity: "fatal" }, NOW).map((entry) => entry.groupId), ["old-fatal"]);
  assert.deepEqual(applyBrowserFilters(rows, { ...DEFAULT_QUERY, isNew: true }, NOW).map((entry) => entry.groupId), ["new-error"]);
});

test("equal rows keep a stable order under every sort", () => {
  const rows = ["a", "b", "c", "d"].map((id) => row(id));
  for (const sort of ["24h", "7d", "users", "last"] as const) {
    assert.deepEqual(applyBrowserFilters(rows, { ...DEFAULT_QUERY, sort }, NOW).map((entry) => entry.groupId), ["a", "b", "c", "d"], sort);
  }
  const ranked = applyBrowserFilters([row("low", { count24h: 1 }), row("high", { count24h: 9 })], DEFAULT_QUERY, NOW);
  assert.deepEqual(ranked.map((entry) => entry.groupId), ["high", "low"]);
});

test("sorting by last seen puts the most recent issue first", () => {
  const rows = [row("older", { lastSeen: "2026-11-10 00:00:00.000" }), row("recent", { lastSeen: "2026-11-12 11:59:00.000" })];
  assert.deepEqual(applyBrowserFilters(rows, { ...DEFAULT_QUERY, sort: "last" }, NOW).map((entry) => entry.groupId), ["recent", "older"]);
});

test("needs triage plus assigned equals all open, and counts are absent when the base set is capped", () => {
  const rows = [row("a"), row("b", { assignedUserId: "me-id" }), row("c", { assignedUserId: "x", state: "reopened" })];
  const counts = viewCounts({ rows, total: 3, truncated: false, complete: true }, "me-id");
  assert.ok(counts);
  assert.equal(counts["needs-triage"] + rows.filter((entry) => entry.assignedUserId).length, counts["all-open"]);
  assert.equal(counts.mine, 1);
  assert.equal(counts.reopened, 1);
  assert.equal(viewCounts({ rows, total: 600, truncated: true, complete: true }, "me-id"), null);
  assert.equal(viewCounts({ rows, total: 3, truncated: false, complete: false }, "me-id"), null);
});

test("typing in an input, or holding a modifier, never moves the row cursor", () => {
  const base = { key: "j", tagName: "DIV", isContentEditable: false, altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(listShortcut(base), "next");
  assert.equal(listShortcut({ ...base, tagName: "INPUT" }), null);
  assert.equal(listShortcut({ ...base, tagName: "textarea" }), null);
  assert.equal(listShortcut({ ...base, isContentEditable: true }), null);
  assert.equal(listShortcut({ ...base, metaKey: true }), null);
  assert.equal(listShortcut({ ...base, key: "/" }), "search");
});

test("the row cursor stops at the first and last row", () => {
  assert.equal(stepRow(-1, 1, 3), 0);
  assert.equal(stepRow(0, -1, 3), 0);
  assert.equal(stepRow(2, 1, 3), 2);
  assert.equal(stepRow(1, 1, 3), 2);
  assert.equal(stepRow(-1, 1, 0), -1);
});
