import type { ProjectMembership, User } from "@ekeeper/shared";

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface AuthedContext {
  user: User;
  memberships: ProjectMembership[];
  session: SessionRecord;
}
