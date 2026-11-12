import type { MeResponse } from "@ekeeper/shared";

// A pure mirror of the backend guards, so the UI shows a control exactly when its API call would succeed.
// The backend stays the authority; these only decide what to render. If a guard in
// backend/src/lib/auth.ts or a requireWorkspaceRole call in backend/src/routes/api.ts changes, change the
// matching rule here and its table test, or the UI will offer buttons that 403 (or hide ones that work).

type Me = Pick<MeResponse, "user" | "memberships">;

/**
 * requireProjectAccess(ctx, projectId, true): admin, or a manager membership on that project. The
 * workspace role does not matter beyond admin, so a workspace viewer with a manager membership CAN close
 * and assign issues in that project. Gates Close, Assign and GitHub integration writes.
 */
export function canWriteProject(me: Me, projectId: string): boolean {
  if (me.user.role === "admin") {
    return true;
  }
  return me.memberships.some((membership) => membership.projectId === projectId && membership.role === "manager");
}

/** Workspace-wide writes: users, projects, source map upload and cleanup, token and key rotation. */
export function isAdmin(me: Me): boolean {
  return me.user.role === "admin";
}

export const SETTINGS_SECTIONS = [
  { id: "projects", label: "Projects" },
  { id: "members", label: "Members" },
  { id: "source-maps", label: "Source maps" },
  { id: "github", label: "GitHub" },
  { id: "mcp", label: "MCP access" },
  { id: "server", label: "Server" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Sections a role can open. Both the sub-nav and the route guard read this one list.
 * members: GET /api/users is admin and viewer (routes/api.ts:474).
 * source-maps: GET /api/minimaps is admin and viewer (routes/api.ts:696).
 * server: the upload token is admin only (routes/api.ts:675); the display values also appear in the
 * Projects section's "Connect an app", so nothing is lost by hiding the section from other roles.
 */
export function visibleSettingsSections(me: Me): SettingsSectionId[] {
  const role = me.user.role;
  return SETTINGS_SECTIONS.map((section) => section.id).filter((id) => {
    if (id === "members" || id === "source-maps") {
      return role === "admin" || role === "viewer";
    }
    if (id === "server") {
      return role === "admin";
    }
    return true;
  });
}
