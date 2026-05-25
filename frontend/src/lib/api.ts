import type {
  DashboardProjectCard,
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
    const body = await response.json().catch(() => ({ message: "Request failed" }));
    throw new Error(body.message ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<MeResponse>("/api/me"),
  users: () => request<{ users: User[] }>("/api/users"),
  createUser: (payload: Pick<User, "email" | "name" | "avatarUrl" | "role" | "status">) =>
    request<{ user: User }>("/api/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (userId: string, payload: Partial<Pick<User, "name" | "avatarUrl" | "role" | "status">>) =>
    request<{ user: User }>(`/api/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteUser: (userId: string) => request<{ success: boolean }>(`/api/users/${userId}`, { method: "DELETE" }),
  projects: () => request<{ projects: Array<Project & { key: ProjectKey | null }> }>("/api/projects"),
  createProject: (payload: Pick<Project, "name" | "slug" | "environment" | "active">) =>
    request<{ project: Project & { key: ProjectKey | null } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateProject: (projectId: string, payload: Partial<Pick<Project, "name" | "slug" | "environment" | "active">>) =>
    request<{ project: Project & { key: ProjectKey | null } }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteProject: (projectId: string) =>
    request<{ success: boolean }>(`/api/projects/${projectId}`, { method: "DELETE" }),
  projectMembers: (projectId: string) =>
    request<{ memberships: ProjectMembership[] }>(`/api/projects/${projectId}/members`),
  setProjectMember: (projectId: string, userId: string, role: "manager" | "viewer") =>
    request<{ success: boolean }>(`/api/projects/${projectId}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeProjectMember: (projectId: string, userId: string) =>
    request<{ success: boolean }>(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
  errorAssignees: (projectId?: string) =>
    request<{ users: User[] }>(projectId ? `/api/error-assignees?projectId=${projectId}` : "/api/error-assignees"),
  dashboard: () => request<{ cards: DashboardProjectCard[] }>("/api/dashboard/summary?range=7d"),
  serverSettings: () => request<{ settings: ServerSettings }>("/api/settings/server"),
  regenerateServerToken: () => request<{ settings: ServerSettings }>("/api/settings/server/regenerate-token", { method: "POST" }),
  minimaps: (projectId?: string) =>
    request<{ artifacts: MinimapArtifact[]; olderThanThirtyDays: number }>(
      projectId ? `/api/minimaps?projectId=${encodeURIComponent(projectId)}` : "/api/minimaps",
    ),
  uploadMinimap: (payload: FormData) =>
    request<{ artifact: MinimapArtifact }>("/api/minimaps/upload", {
      method: "POST",
      body: payload,
    }),
  cleanupOldMinimaps: () =>
    request<{ deleted: number; artifacts: MinimapArtifact[] }>("/api/minimaps/cleanup-old", {
      method: "POST",
    }),
  errors: (
    projectId?: string,
    filters?: { state?: string; assignment?: string; assignedUserId?: string; user?: string },
  ) => {
    const search = new URLSearchParams();
    if (filters?.state) search.set("state", filters.state);
    if (filters?.assignment) search.set("assignment", filters.assignment);
    if (filters?.assignedUserId) search.set("assignedUserId", filters.assignedUserId);
    if (filters?.user) search.set("user", filters.user);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<{ errors: ErrorGroupSummary[] }>(
      projectId ? `/api/projects/${projectId}/errors${suffix}` : `/api/projects/all/errors${suffix}`,
    );
  },
  githubIntegration: (projectId: string) =>
    request<{ integration: ProjectGithubIntegration | null }>(
      `/api/projects/${projectId}/github-integration`,
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
      `/api/projects/${projectId}/github-integration`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  deleteGithubIntegration: (projectId: string) =>
    request<{ success: boolean }>(`/api/projects/${projectId}/github-integration`, {
      method: "DELETE",
    }),
  backfillGithubIntegration: (projectId: string) =>
    request<{
      totalGroups: number;
      alreadyLinked: number;
      candidatesProcessed: number;
      created: number;
      failed: number;
    }>(`/api/projects/${projectId}/github-integration/backfill`, { method: "POST" }),
  cleanupDuplicateGithubIssues: (projectId: string) =>
    request<{
      fingerprintsScanned: number;
      duplicatesClosed: number;
      linksRepaired: number;
      labelsAdded: number;
    }>(`/api/projects/${projectId}/github-integration/cleanup-duplicates`, { method: "POST" }),
  errorDetail: (projectId: string, groupId: string, eventId?: string) =>
    request<{ error: ErrorEventDetail | null; occurrences: OccurrenceSummary[] }>(
      `/api/projects/${projectId}/errors/${groupId}${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ""}`,
    ),
  updateIssueWorkflow: (projectId: string, groupId: string, payload: { state?: IssueState; assignedUserId?: string | null }) =>
    request<{ issue: ErrorGroupSummary | undefined }>(`/api/projects/${projectId}/errors/${groupId}/workflow`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  loginUrl: () => request<{ url: string }>("/auth/google/start", { method: "POST" }),
  logout: () => request<{ success: boolean }>("/auth/logout", { method: "POST" }),
};

export const roleOptions: UserRole[] = ["admin", "manager", "viewer"];
