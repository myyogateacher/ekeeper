export type UserRole = "admin" | "manager" | "viewer";
export type UserStatus = "active" | "disabled";
export type ProjectMembershipRole = "manager" | "viewer";
export type IssueState = "open" | "closed" | "reopened";

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  environment: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectKey {
  id: string;
  projectId: string;
  publicKey: string;
  secretKey: string;
  dsn: string;
  createdAt: string;
}

export interface ProjectMembership {
  userId: string;
  projectId: string;
  role: ProjectMembershipRole;
  createdAt: string;
}

export interface DashboardProjectCard {
  projectId: string;
  projectName: string;
  totalEvents7d: number;
  recurringGroups7d: number;
  impactedUsers7d: number;
  trendPercent: number;
  topGroupTitle: string | null;
}

export interface ErrorGroupSummary {
  groupId: string;
  projectId: string;
  title: string;
  fingerprint: string;
  count7d: number;
  count24h: number;
  firstSeen: string;
  lastSeen: string;
  severity: string;
  affectedUsers: number;
  state: IssueState;
  assignedUserId: string | null;
  assignedUserName: string | null;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
}

export interface ProjectGithubIntegration {
  projectId: string;
  owner: string;
  repo: string;
  defaultLabels: string[];
  webhookSecretSet: boolean;
  personalAccessTokenSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Breadcrumb {
  timestamp: string;
  category: string;
  level: string;
  message: string;
  type: string;
  data: Record<string, unknown>;
}

export interface MinimapArtifact {
  id: string;
  org: string;
  projectId: string;
  project: string;
  release: string;
  dist: string | null;
  artifactName: string;
  checksum: string;
  filePath: string;
  contentType: string | null;
  size: number;
  uploadedAt: string;
  expiresAt: string;
}

// Display-safe server settings, readable by every signed-in role. The upload
// auth token is intentionally excluded — it authorizes plugin artifact uploads
// and is served to admins only via GET /api/settings/server/token.
export interface ServerSettings {
  ekeeperOrg: string;
  ekeeperUrl: string;
  minimapsRetentionDays: number;
  minimapsKeepReleases: number;
}

export interface ErrorEventDetail {
  eventId: string;
  groupId: string;
  projectId?: string;
  message: string;
  exception: Record<string, unknown>;
  // Frames (here and under exception.values[].stacktrace.frames) come from the SDK and are not typed on
  // purpose: a public DSN can send any JSON, so a reader validates each field it uses. What the backend adds
  // to a frame (backend/src/lib/stack-frames.ts): `in_app: false` plus `package` on a frame whose mapped file
  // sits under node_modules, and `pre_context` (string[], at most 3 lines before), `context_line` and
  // `post_context` (at most 3 after) on a source mapped frame whose map carries the source text. A frame
  // without those fields has no source to show.
  stacktrace: Record<string, unknown> | null;
  browser: string | null;
  device: string | null;
  os: string | null;
  runtime: string | null;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  rawPayload: string;
  timestamp: string;
  state: IssueState;
  assignedUserId: string | null;
  assignedUserName: string | null;
  sourceMapApplied: boolean;
  sourceMapRelease: string | null;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  // Distinct non-empty user_id over every event of the group, all time: the same expression and window as
  // ErrorGroupSummary.affectedUsers, so the list and the issue page agree.
  affectedUsers: number;
  // When the issue was closed, ISO 8601 UTC with Z; null unless state is "closed".
  closedAt: string | null;
}

// Whole-group figures for the issue page. Timestamps here are ISO 8601 UTC with Z; `error.timestamp` and the
// other ClickHouse times on the same response are zoneless "YYYY-MM-DD HH:mm:ss.SSS" UTC digits, which
// parseServerTime in the frontend reads either way.
export interface IssueStats {
  totalEvents: number;
  // Rolling windows ending now, the same definition as ErrorGroupSummary.count24h and count7d.
  events24h: number;
  events7d: number;
  // Exactly 24 counts, oldest first, in rolling hours from one server clock reading shared with events24h:
  // hourly24h[i] counts events in [now - (24 - i)h, now - (23 - i)h). The last entry has no upper bound, so an
  // event stamped ahead of the server clock lands in it, which keeps sum(hourly24h) equal to events24h.
  hourly24h: number[];
  firstSeen: string | null;
  lastSeen: string | null;
}

// Where the shown event sits in its group, newest first. Replaces the unbounded `occurrences` list the
// detail response used to carry.
export interface EventNavigation {
  // The group's newest and oldest events, always set. They equal the shown event at the edges, so a Latest
  // or Oldest control is disabled by comparing against the shown event id or by newer/older being null.
  latestEventId: string;
  oldestEventId: string;
  // The adjacent events, null at the edge.
  newerEventId: string | null;
  olderEventId: string | null;
  // 1 is the newest event. Always between 1 and total.
  position: number;
  total: number;
}

export interface ErrorDetailResponse {
  // null when the group has no event, or no event with the requested eventId.
  error: ErrorEventDetail | null;
  // Zeroes and nulls for an unknown group.
  stats: IssueStats;
  // null exactly when `error` is null.
  navigation: EventNavigation | null;
  duplicateGroups: DuplicateIssueGroup[];
}

// POST /api/errors/affected-users: distinct users over the union of the listed groups, so the issues list
// header can show "N users affected" for the visible rows. Per-group counts cannot be summed (one user can
// hit several groups). At most 500 groups, each id at most 4096 characters; anything else is a 400.
export interface AffectedUsersRequest {
  groups: Array<{ projectId: string; groupId: string }>;
}

export interface AffectedUsersResponse {
  affectedUsers: number;
}

// GET /api/projects/:projectId/ingest-status, for the Connect an app "Verify" step.
export interface IngestStatus {
  // ISO 8601 UTC with Z of the project's newest event; null when it has none.
  lastEventAt: string | null;
  // The release of the project's newest event (argMax(release, timestamp)); null when the project has no event
  // or that event has no release. This is the release the app is running, not the newest upload: a build can
  // upload source maps before it has sent an event.
  latestRelease: string | null;
  // Source map (.map) files uploaded for exactly latestRelease; 0 when none, or when latestRelease is null.
  sourceMapFiles: number;
}

export interface DuplicateIssueGroup {
  groupId: string;
  title: string;
  message: string;
  fingerprint: string;
  events: number;
  affectedUsers: number;
  firstSeen: string;
  lastSeen: string;
  latestRelease: string | null;
}

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MeResponse {
  user: User;
  memberships: ProjectMembership[];
}

export interface IngestEnvelopeItem {
  type: string;
  payload: Record<string, unknown>;
}

export interface NormalizedIngestEvent {
  eventId: string;
  projectId: string;
  groupId: string;
  fingerprint: string;
  title: string;
  message: string;
  severity: string;
  timestamp: string;
  release: string | null;
  environment: string | null;
  userId: string | null;
  userEmail: string | null;
  userUsername: string | null;
  browser: string | null;
  device: string | null;
  os: string | null;
  runtime: string | null;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  exception: Record<string, unknown>;
  stacktrace: Record<string, unknown> | null;
  breadcrumbs: Breadcrumb[];
  rawPayload: string;
}
