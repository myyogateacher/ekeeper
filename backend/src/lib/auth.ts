import { createRemoteJWKSet, jwtVerify } from "jose";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "../config";
import { all, one, run } from "../db/sqlite";
import { HttpError } from "./http";
import { createId, randomToken } from "./ids";
import type { ProjectMembership, User } from "@ekeeper/shared";
import type { AuthedContext } from "../types/api";
import { connectRedis } from "./redis";

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface SessionLookup {
  sessionId: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

const sessionKey = (sessionId: string) => `ekeeper:session:${sessionId}`;
const userSessionsKey = (userId: string) => `ekeeper:user-sessions:${userId}`;

export async function createGoogleAuthUrl(ctx: Context) {
  const state = randomToken(18);
  setCookie(ctx, "oauth_state", state, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return url.toString();
}

export async function handleGoogleCallback(code: string, state: string) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: config.GOOGLE_CALLBACK_URL,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new HttpError(401, "Google sign-in failed");
  }

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new HttpError(401, "Google did not return an ID token");
  }

  const verified = await jwtVerify(tokens.id_token, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: config.GOOGLE_CLIENT_ID,
  });

  const payload = verified.payload;
  const email = String(payload.email ?? "").toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!config.allowedDomains.includes(domain)) {
    throw new HttpError(403, "Google account domain is not allowed");
  }

  const now = new Date().toISOString();
  const totalUsersRow = one<{ total: number }>("SELECT COUNT(*) AS total FROM users");
  const existingUser = one<User>(
    `SELECT id, email, name, avatar_url as avatarUrl, role, status, created_at as createdAt, updated_at as updatedAt
     FROM users WHERE email = ?`,
    [email],
  );

  const user =
    existingUser ??
    (() => {
      const newUser = {
        id: createId("user"),
        email,
        name: String(payload.name ?? email),
        avatarUrl: payload.picture ? String(payload.picture) : null,
        role: totalUsersRow?.total === 0 ? "admin" : "viewer",
        status: "active",
        createdAt: now,
        updatedAt: now,
      } satisfies User;
      run(
        `INSERT INTO users (id, email, name, avatar_url, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newUser.id, newUser.email, newUser.name, newUser.avatarUrl, newUser.role, newUser.status, now, now],
      );
      return newUser;
    })();

  if (user.status !== "active") {
    throw new HttpError(403, "This account is disabled");
  }

  return user;
}

export function createSession(ctx: Context, userId: string) {
  return createSessionInRedis(ctx, userId);
}

async function createSessionInRedis(ctx: Context, userId: string) {
  const sessionId = randomToken(32);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const redis = await connectRedis();
  await redis
    .multi()
    .set(
      sessionKey(sessionId),
      JSON.stringify({
        sessionId,
        userId,
        expiresAt,
        createdAt,
      } satisfies SessionLookup),
      { EX: config.SESSION_TTL_HOURS * 60 * 60 },
    )
    .sAdd(userSessionsKey(userId), sessionId)
    .exec();

  setCookie(ctx, config.SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSession(ctx: Context) {
  return clearSessionInRedis(ctx);
}

async function clearSessionInRedis(ctx: Context) {
  const token = getCookie(ctx, config.SESSION_COOKIE_NAME);
  if (token) {
    await deleteSessionById(token);
  }
  deleteCookie(ctx, config.SESSION_COOKIE_NAME, { path: "/" });
}

export async function loadSession(ctx: Context): Promise<AuthedContext | null> {
  const token = getCookie(ctx, config.SESSION_COOKIE_NAME);
  if (!token) {
    return null;
  }

  const session = await getSessionById(token);

  if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
    await deleteSessionById(token);
    return null;
  }

  const user = one<User>(
    `SELECT id, email, name, avatar_url as avatarUrl, role, status, created_at as createdAt, updated_at as updatedAt
     FROM users WHERE id = ?`,
    [session.userId],
  );

  if (!user || user.status !== "active") {
    await deleteSessionById(token);
    return null;
  }

  const memberships = all<ProjectMembership>(
    `SELECT user_id as userId, project_id as projectId, role, created_at as createdAt
     FROM project_memberships WHERE user_id = ?`,
    [user.id],
  );

  return {
    user,
    memberships,
    session: {
      id: session.sessionId,
      userId: session.userId,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
    },
  };
}

async function getSessionById(sessionId: string): Promise<SessionLookup | null> {
  const redis = await connectRedis();
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SessionLookup;
  } catch {
    await redis.del(sessionKey(sessionId));
    return null;
  }
}

async function deleteSessionById(sessionId: string) {
  const redis = await connectRedis();
  const session = await getSessionById(sessionId);
  const multi = redis.multi().del(sessionKey(sessionId));

  if (session) {
    multi.sRem(userSessionsKey(session.userId), sessionId);
  }

  await multi.exec();
}

export async function clearUserSessions(userId: string) {
  const redis = await connectRedis();
  const sessionIds = await redis.sMembers(userSessionsKey(userId));
  const multi = redis.multi();

  for (const sessionId of sessionIds) {
    multi.del(sessionKey(sessionId));
  }

  multi.del(userSessionsKey(userId));
  await multi.exec();
}

export const sessionMiddleware: MiddlewareHandler = async (ctx, next) => {
  const session = await loadSession(ctx);
  if (session) {
    ctx.set("auth", session);
  }
  await next();
};

export function requireAuth(ctx: Context): AuthedContext {
  const auth = ctx.get("auth") as AuthedContext | undefined;
  if (!auth) {
    throw new HttpError(401, "Authentication required");
  }

  return auth;
}

export function requireWorkspaceRole(ctx: Context, roles: User["role"][]) {
  const auth = requireAuth(ctx);
  if (!roles.includes(auth.user.role)) {
    throw new HttpError(403, "Insufficient permissions");
  }
  return auth;
}

export function requireProjectAccess(ctx: Context, projectId: string, requireWrite = false) {
  const auth = requireAuth(ctx);
  if (auth.user.role === "admin" || (!requireWrite && auth.user.role === "viewer")) {
    return auth;
  }

  const membership = auth.memberships.find((entry) => entry.projectId === projectId);
  if (!membership) {
    throw new HttpError(403, "Project access denied");
  }

  if (requireWrite && membership.role !== "manager") {
    throw new HttpError(403, "Project write access denied");
  }

  return auth;
}
