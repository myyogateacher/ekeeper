import { isApiStatus } from "./api-error.ts";

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
