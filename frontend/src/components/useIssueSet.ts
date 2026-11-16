import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchIssueSet } from "@/lib/api";
import { toApiFilters, type ListQuery } from "@/lib/issue-list";

type SetQuery = Pick<ListQuery, "status" | "assignee" | "projectId" | "user" | "range" | "from" | "to">;

/**
 * The cache key of one list's rows. Exported because the issue page reads a list back from the cache by this
 * key (Issue N of M), and two copies of a key drift: the page would then step through nothing and say nothing.
 */
export function issueSetKey(query: SetQuery) {
  return ["errors", "set", query.status, query.assignee, query.projectId, query.user, query.range, query.from, query.to] as const;
}

/**
 * The server-side part of a list query, keyed on the query fields the API uses (not on the computed
 * `from` instant, which changes every millisecond). The shell's base set and the default list view build
 * the same key, so the home page costs one load, not two.
 *
 * staleTime is 60 s because ingest writes to ClickHouse at most every 5 minutes
 * (backend/src/lib/ingest-buffer.ts:14); refetching more often only repeats the aggregation.
 */
export function useIssueSet(query: SetQuery, meId: string) {
  return useQuery({
    queryKey: issueSetKey(query),
    queryFn: () => fetchIssueSet(toApiFilters({ ...BASE, ...query }, meId, Date.now())),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

const BASE = { q: "", severity: null, isNew: false, sort: "24h" } as const;
