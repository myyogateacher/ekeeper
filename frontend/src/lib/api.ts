import type {
  DuplicateIssueGroup,
  ErrorEventDetail,
  ErrorGroupSummary,
  IssueState,
  MeResponse,
  MinimapArtifact,
  OccurrenceSummary,
  Project,
  ProjectGithubIntegration,
  ProjectMembership,
  ProjectKey,
  ServerSettings,
  User,
  UserRole,
} from "@ekeeper/shared";
import { ApiError } from "@/lib/api-error";
import { path } from "@/lib/url";
import { userOrSignedOut } from "@/lib/session";
import {
  ISSUE_LIST_PAGE_SIZE,
  mergePages,
  remainingPageOffsets,
  type ApiFilters,
  type IssueSet,
} from "@/lib/issue-list";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(input, {
    credentials: "include",
    headers: isFormData
      ? init?.headers
      : {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
    ...init,
  });

  if (!response.ok) {
    // A non-JSON error body (a proxy's HTML 502 page) still has to surface as an ApiError with its status.
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? `Request failed (${response.status})`, response.status);
  }

  return response.json() as Promise<T>;
}

export const api = {
  // Signed out resolves to null instead of a 401 error: see lib/session.ts for the loop that prevents.
  me: () => userOrSignedOut(() => request<MeResponse>("/api/me")),
  users: () => request<{ users: User[] }>("/api/users"),
  createUser: (payload: Pick<User, "email" | "name" | "avatarUrl" | "role" | "status">) =>
    request<{ user: User }>("/api/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (userId: string, payload: Partial<Pick<User, "name" | "avatarUrl" | "role" | "status">>) =>
    request<{ user: User }>(path`/api/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteUser: (userId: string) => request<{ success: boolean }>(path`/api/users/${userId}`, { method: "DELETE" }),
  projects: () => request<{ projects: Array<Project & { key: ProjectKey | null }> }>("/api/projects"),
  createProject: (payload: Pick<Project, "name" | "slug" | "environment" | "active">) =>
    request<{ project: Project & { key: ProjectKey | null } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateProject: (projectId: string, payload: Partial<Pick<Project, "name" | "slug" | "environment" | "active">>) =>
    request<{ project: Project & { key: ProjectKey | null } }>(path`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteProject: (projectId: string) =>
    request<{ success: boolean }>(path`/api/projects/${projectId}`, { method: "DELETE" }),
  projectMembers: (projectId: string) =>
    request<{ memberships: ProjectMembership[] }>(path`/api/projects/${projectId}/members`),
  setProjectMember: (projectId: string, userId: string, role: "manager" | "viewer") =>
    request<{ success: boolean }>(path`/api/projects/${projectId}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeProjectMember: (projectId: string, userId: string) =>
    request<{ success: boolean }>(path`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
  errorAssignees: (projectId?: string) =>
    request<{ users: User[] }>(projectId ? "/api/error-assignees?" + new URLSearchParams({ projectId }) : "/api/error-assignees"),
  serverSettings: () => request<{ settings: ServerSettings }>("/api/settings/server"),
  serverUploadToken: () => request<{ token: string }>("/api/settings/server/token"),
  regenerateServerToken: () => request<{ token: string }>("/api/settings/server/regenerate-token", { method: "POST" }),
  mcpKey: () => request<{ key: string }>("/api/settings/mcp-key"),
  regenerateMcpKey: () => request<{ key: string }>("/api/settings/mcp-key/regenerate", { method: "POST" }),
  minimaps: (projectId?: string, pagination?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (projectId) search.set("projectId", projectId);
    if (pagination?.limit !== undefined) search.set("limit", String(pagination.limit));
    if (pagination?.offset !== undefined) search.set("offset", String(pagination.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<{
      artifacts: MinimapArtifact[];
      total: number;
      limit: number;
      offset: number;
      retentionEligible: number;
    }>("/api/minimaps" + suffix);
  },
  uploadMinimap: (payload: FormData) =>
    request<{ artifact: MinimapArtifact }>("/api/minimaps/upload", {
      method: "POST",
      body: payload,
    }),
  cleanupOldMinimaps: (projectId?: string) =>
    request<{ started: boolean; eligible: number }>(
      projectId ? "/api/minimaps/cleanup-old?" + new URLSearchParams({ projectId }) : "/api/minimaps/cleanup-old",
      { method: "POST" },
    ),
  errors: (
    projectId?: string,
    filters?: {
      state?: string;
      assignment?: string;
      assignedUserId?: string;
      user?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    },
  ) => {
    const search = new URLSearchParams();
    if (filters?.state) search.set("state", filters.state);
    if (filters?.assignment) search.set("assignment", filters.assignment);
    if (filters?.assignedUserId) search.set("assignedUserId", filters.assignedUserId);
    if (filters?.user) search.set("user", filters.user);
    if (filters?.from) search.set("from", filters.from);
    if (filters?.to) search.set("to", filters.to);
    if (filters?.limit !== undefined) search.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) search.set("offset", String(filters.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<{ errors: ErrorGroupSummary[]; total: number; limit: number; offset: number }>(
      projectId ? path`/api/projects/${projectId}/errors` + suffix : "/api/projects/all/errors" + suffix,
    );
  },
  githubIntegration: (projectId: string) =>
    request<{ integration: ProjectGithubIntegration | null }>(
      path`/api/projects/${projectId}/github-integration`,
    ),
  saveGithubIntegration: (
    projectId: string,
    payload: {
      owner: string;
      repo: string;
      defaultLabels: string[];
      webhookSecret: string | null;
      personalAccessToken: string | null;
    },
  ) =>
    request<{ integration: ProjectGithubIntegration | null }>(
      path`/api/projects/${projectId}/github-integration`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  deleteGithubIntegration: (projectId: string) =>
    request<{ success: boolean }>(path`/api/projects/${projectId}/github-integration`, {
      method: "DELETE",
    }),
  backfillGithubIntegration: (projectId: string) =>
    request<{
      totalGroups: number;
      alreadyLinked: number;
      candidatesProcessed: number;
      created: number;
      failed: number;
    }>(path`/api/projects/${projectId}/github-integration/backfill`, { method: "POST" }),
  cleanupDuplicateGithubIssues: (projectId: string) =>
    request<{
      titlesScanned: number;
      duplicatesClosed: number;
      linksRepaired: number;
      labelsAdded: number;
    }>(path`/api/projects/${projectId}/github-integration/cleanup-duplicates`, { method: "POST" }),
  errorDetail: (projectId: string, groupId: string, eventId?: string) =>
    request<{ error: ErrorEventDetail | null; occurrences: OccurrenceSummary[]; duplicateGroups: DuplicateIssueGroup[] }>(
      path`/api/projects/${projectId}/errors/${groupId}` + (eventId ? `?${new URLSearchParams({ eventId })}` : ""),
    ),
  updateIssueWorkflow: (projectId: string, groupId: string, payload: { state?: IssueState; assignedUserId?: string | null }) =>
    request<{ issue: ErrorGroupSummary | undefined }>(path`/api/projects/${projectId}/errors/${groupId}/workflow`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  loginUrl: () => request<{ url: string }>("/auth/google/start", { method: "POST" }),
  logout: () => request<{ success: boolean }>("/auth/logout", { method: "POST" }),
};

export const roleOptions: UserRole[] = ["admin", "manager", "viewer"];

/**
 * Loads a whole issue view up to ISSUE_LIST_MAX_ROWS: the first page, then the rest in parallel. If the
 * pages disagree (an issue closed or re-ranked between requests, see mergePages) the set is fetched once
 * more; a second disagreement is returned as incomplete and the page says the list changed while loading.
 */
export async function fetchIssueSet(filters: ApiFilters): Promise<IssueSet> {
  const { projectId, ...rest } = filters;
  const load = async () => {
    const first = await api.errors(projectId, { ...rest, limit: ISSUE_LIST_PAGE_SIZE, offset: 0 });
    const others = await Promise.all(
      remainingPageOffsets(first.total).map((offset) =>
        api.errors(projectId, { ...rest, limit: ISSUE_LIST_PAGE_SIZE, offset }),
      ),
    );
    return mergePages([first, ...others]);
  };
  const set = await load();
  return set.complete ? set : load();
}
