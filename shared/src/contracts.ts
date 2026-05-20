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

export interface ServerSettings {
  ekeeperOrg: string;
  ekeeperUrl: string;
  ekeeperAuthToken: string;
}

export interface ErrorEventDetail {
  eventId: string;
  groupId: string;
  projectId?: string;
  message: string;
  exception: Record<string, unknown>;
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
}

export interface OccurrenceSummary {
  eventId: string;
  timestamp: string;
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
