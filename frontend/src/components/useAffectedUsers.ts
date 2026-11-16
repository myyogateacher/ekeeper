import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { IssueKey } from "@/lib/issue-list";

/**
 * The list header's "N users affected" over `groups` (lib/issue-list.ts affectedUsersScope), or no query at all
 * while `groups` is null. The set itself is the cache key, so a search that narrows the rows asks again and a
 * figure is never shown beside rows it was not counted over; there is deliberately no placeholderData, because
 * the previous set's figure under a new list would be a wrong number, and a short gap is the lesser fault.
 *
 * The key does not start with "errors": a status or owner change invalidates ["errors"] (components/workflow.tsx)
 * and would re-run this for a set whose users did not change. If a change does alter the rows, the set in the
 * key changes with them and the figure is asked again anyway.
 *
 * staleTime matches the list's 60 s: ingest writes at most every 5 minutes (useIssueSet.ts).
 */
export function useAffectedUsers(groups: IssueKey[] | null) {
  return useQuery({
    queryKey: ["affected-users", groups],
    queryFn: () => api.affectedUsers(groups!),
    enabled: groups !== null,
    staleTime: 60_000,
  });
}
