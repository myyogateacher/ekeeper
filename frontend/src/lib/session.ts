import type { QueryClient } from "@tanstack/react-query";
import { isApiStatus } from "./api-error.ts";

/** The cache key of the session query ("who am I"); everything else cached belongs to that one user. */
export const SESSION_KEY = ["me"] as const;

/** BroadcastChannel name the tabs of this app use to tell each other who is signed in. */
export const SESSION_CHANNEL = "ekeeper:session";

/**
 * Runs the "who am I" request and turns a 401 into `null`, so signed out is a value the query cache holds
 * and not a failure.
 *
 * Why not let the 401 propagate and handle it globally: the session query is mounted by ProtectedLayout
 * and the shell watches every query's errors to react to an ended session. A 401 on the session query
 * itself then re-triggered that reaction, which cleared the query, which the mounted observer refetched,
 * which failed with a 401 again: about 3,900 requests in 3 s and a loader that never reached /login.
 * Callers must keep this mapping on the session query only; a 401 on any other query still means the session
 * ended and is handled by writing `null` into the session query (main.tsx), never by removing or
 * invalidating it.
 *
 * Only 401 is mapped. A 403, a 5xx or a network failure rethrows, so an outage is not mistaken for
 * "signed out": ProtectedLayout shows a "Couldn't reach eKeeper" state with Try again instead of redirecting
 * to /login.
 */
export async function userOrSignedOut<T>(fetchMe: () => Promise<T>): Promise<T | null> {
  try {
    return await fetchMe();
  } catch (error) {
    if (isApiStatus(error, 401)) {
      return null;
    }
    throw error;
  }
}

const isNotSession = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== SESSION_KEY[0];

/**
 * The session is over (logout, or a 401 on any request): drop every cached query except the session's own and
 * set that one to null, so the next signed-in user in this tab never sees this user's data (shared browsers:
 * tab A, admin, went Back to a cached list after tab B signed in as someone else). The session query is
 * written, not removed or invalidated: ProtectedLayout has it mounted, and either one refetches it at once,
 * which is how a signed-out user used to loop on the loader.
 */
export function endSession(client: QueryClient): void {
  client.removeQueries({ predicate: isNotSession });
  client.setQueryData(SESSION_KEY, null);
}

/**
 * Another tab reports a different user. Reset every cached query but the session's: their data goes at once
 * (a mounted page shows its loading state instead of the previous user's rows) and the active ones refetch
 * under the cookie this tab now has. The session query is refetched, not reset, so the shell keeps rendering
 * until it learns who the user is now, and a null answer then sends the tab to /login.
 */
export async function dropCachedQueries(client: QueryClient): Promise<void> {
  const reset = client.resetQueries({ predicate: isNotSession });
  await Promise.all([reset, client.refetchQueries({ queryKey: SESSION_KEY })]);
}

/**
 * What a tab tells the others: the id of the user it is signed in as, or null when it is signed out.
 * `loggedOut` is set only by the Log out button, so a tab that hears it forgets its remembered page; a
 * session that merely expired also reads as userId null, and must keep its page.
 */
export interface SessionMessage {
  userId: string | null;
  loggedOut?: true;
}

/** Only a message that names a user id or null is read; anything else (another version's shape) is ignored. */
export function parseSessionMessage(data: unknown): SessionMessage | null {
  if (data === null || typeof data !== "object" || !("userId" in data)) return null;
  const { userId } = data;
  if (userId !== null && typeof userId !== "string") return null;
  return "loggedOut" in data && data.loggedOut === true ? { userId, loggedOut: true } : { userId };
}

/** True when this tab holds data for a different user than the one the message names, signed out included. */
export function mustDropCache(ownUserId: string | null, message: SessionMessage): boolean {
  return message.userId !== ownUserId;
}
