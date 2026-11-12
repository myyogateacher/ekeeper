import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { meQuery } from "@/lib/api";
import { SESSION_CHANNEL, dropCachedQueries, mustDropCache, parseSessionMessage } from "@/lib/session";

/**
 * Keeps the tabs of one browser from showing each other's data. They share a cookie jar, so signing out or in
 * as someone else in one tab changes who every tab is, but a tab that was not asked still holds the previous
 * user's cache (and renders it on Back: the tab-A, tab-B leak found in PROD-10519 QA). Each tab posts the user
 * it is signed in as, or null when signed out, whenever that changes; a tab that holds a different user drops
 * its cached queries and asks who it is now (lib/session.ts mustDropCache and dropCachedQueries). A tab that
 * receives its own user's id keeps its cache, which is what stops two tabs of one user from ping-ponging.
 */
export function useSessionSync(): void {
  const queryClient = useQueryClient();
  const { data } = useQuery(meQuery);
  // undefined while the first answer is pending, then the user's id, or null when signed out.
  const userId = data === undefined ? undefined : (data?.user.id ?? null);
  const channel = useRef<BroadcastChannel | null>(null);
  const own = useRef(userId);

  useEffect(() => {
    own.current = userId;
  }, [userId]);

  useEffect(() => {
    // BroadcastChannel is missing in Safari before 15.4 and in Internet Explorer. In those browsers a tab only
    // learns of a sign out or in from its own requests (a 401 or the logout button clears its cache, see
    // endSession); the cross-tab drop is skipped.
    if (typeof BroadcastChannel === "undefined") return;
    const opened = new BroadcastChannel(SESSION_CHANNEL);
    channel.current = opened;
    opened.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseSessionMessage(event.data);
      // A tab still waiting for its first answer has nothing cached from another user, and will ask anyway.
      if (message && own.current !== undefined && mustDropCache(own.current, message)) {
        void dropCachedQueries(queryClient);
      }
    };
    return () => {
      opened.close();
      channel.current = null;
    };
  }, [queryClient]);

  useEffect(() => {
    if (userId !== undefined) channel.current?.postMessage({ userId });
  }, [userId]);
}
