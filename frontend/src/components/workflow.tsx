import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import type { IssueState } from "@ekeeper/shared";
import { api } from "@/lib/api";
import { undoState } from "@/lib/issue-detail";

interface WorkflowChange {
  projectId: string;
  groupId: string;
  payload: { state?: IssueState; assignedUserId?: string | null };
  /** The state before a status change, so the confirmation toast can offer Undo. */
  previousState?: IssueState;
}

/**
 * The one way the UI changes an issue's status or owner, shared by the list and the detail page.
 *
 * No optimistic update: the toast appears only after the PATCH succeeds. A failure is treated as an
 * unknown outcome, not a refusal, because the endpoint writes SQLite first and then syncs GitHub and
 * re-queries ClickHouse (backend/src/routes/api.ts:949-959); either of those can throw after the write
 * landed. So on any failure both views are refetched and the user is told they are seeing the server's
 * state, rather than being shown the old state as if nothing happened.
 */
export function useIssueWorkflow() {
  const queryClient = useQueryClient();

  const refresh = (change: WorkflowChange) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["errors"] }),
      queryClient.invalidateQueries({ queryKey: ["error-detail", change.projectId, change.groupId] }),
    ]);

  const mutation = useMutation({
    mutationFn: (change: WorkflowChange) => api.updateIssueWorkflow(change.projectId, change.groupId, change.payload),
    onSuccess: async (_result, change) => {
      await refresh(change);
      const next = change.payload.state;
      if (!next) {
        toast(change.payload.assignedUserId === null ? "Owner removed" : "Owner updated");
        return;
      }
      const undoTo = undoState(change.previousState, next);
      toast(
        ({ closeToast }) => (
          <span className="flex items-center gap-3">
            <span>{messageFor(next)}</span>
            {undoTo ? (
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => {
                  closeToast?.();
                  mutation.mutate({ ...change, payload: { state: undoTo }, previousState: next });
                }}
              >
                Undo
              </button>
            ) : null}
          </span>
        ),
        { autoClose: 6000 },
      );
    },
    onError: async (error, change) => {
      await refresh(change);
      toast.error(
        `Couldn't confirm the change. Showing the current state.${error instanceof Error ? ` (${error.message})` : ""}`,
      );
    },
  });

  return mutation;
}

function messageFor(state: IssueState): string {
  // Ingest flips a closed group to reopened when a new event is flushed (backend/src/lib/ingest-buffer.ts:136-143).
  if (state === "closed") return "Issue closed. It reopens on its own if the error happens again.";
  if (state === "reopened") return "Issue reopened";
  return "Issue marked open";
}
