import { useOutletContext } from "react-router-dom";
import type { MeResponse } from "@ekeeper/shared";

/**
 * The signed-in user and their memberships, loaded once by ProtectedLayout and passed down the router
 * outlet. Pages used to run their own ["me"] query (four copies) and each rendered a loading state of its
 * own; inside the layout "me" is always present, so pages read it here synchronously.
 */
export function useMe(): MeResponse {
  return useOutletContext<MeResponse>();
}
