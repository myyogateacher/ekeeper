import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchIssueSet } from "@/lib/api";
import { toApiFilters, type ListQuery } from "@/lib/issue-list";

/**
 * The server-side part of a list query, keyed on the query fields the API uses (not on the computed
 * `from` instant, which changes every millisecond). The shell's base set and the default list view build
 * the same key, so the home page costs one load, not two.
 *
 * staleTime is 60 s because ingest writes to ClickHouse at most every 5 minutes
 * (backend/src/lib/ingest-buffer.ts:14); refetching more often only repeats the aggregation.
 */
export function useIssueSet(query: Pick<ListQuery, "status" | "assignee" | "projectId" | "user" | "range" | "from" | "to">, meId: string) {
  return useQuery({
    queryKey: ["errors", "set", query.status, query.assignee, query.projectId, query.user, query.range, query.from, query.to],
    queryFn: () => fetchIssueSet(toApiFilters({ ...BASE, ...query }, meId, Date.now())),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

const BASE = { q: "", severity: null, isNew: false, sort: "24h" } as const;
