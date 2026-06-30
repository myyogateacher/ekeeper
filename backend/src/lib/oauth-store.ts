import { createHash } from "node:crypto";
import { connectRedis } from "./redis";
import { one, run } from "../db/sqlite";
import { randomToken } from "./ids";

const SCOPE = "mcp:read";
const CODE_TTL = 60, ACCESS_TTL = 8 * 3600, REFRESH_TTL = 30 * 86400;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function registerClient(redirectUris: string[], clientName: string) {
  const client_id = `mcpc_${randomToken(16)}`;
  run(`INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)`,
    [client_id, JSON.stringify(redirectUris), clientName ?? "", new Date().toISOString()]);
  return { client_id, redirect_uris: redirectUris };
}

export function getClient(clientId: string) {
  const row = one<{ client_id: string; redirect_uris: string }>(
    `SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?`, [clientId]);
  return row ? { client_id: row.client_id, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

export async function issueCode(d: { userId: string; clientId: string; redirectUri: string; codeChallenge: string }) {
  const code = randomToken(24);
  const redis = await connectRedis();
  await redis.set(`mcp:code:${code}`, JSON.stringify({ ...d, scope: SCOPE }), { EX: CODE_TTL });
  return code;
}

export async function consumeCode(code: string) {
  const redis = await connectRedis();
  const raw = await redis.getDel(`mcp:code:${code}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; clientId: string; redirectUri: string; codeChallenge: string; scope: string };
}

export async function issueTokens(userId: string, clientId: string) {
  const redis = await connectRedis();
  const accessToken = randomToken(32), refreshToken = randomToken(32);
  await redis.set(`mcp:at:${accessToken}`, JSON.stringify({ userId, scope: SCOPE }), { EX: ACCESS_TTL });
  await redis.set(`mcp:rt:${refreshToken}`, JSON.stringify({ userId, clientId, scope: SCOPE }), { EX: REFRESH_TTL });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL, scope: SCOPE };
}

export async function validateAccessToken(token: string) {
  if (!token) return null;
  const redis = await connectRedis();
  const raw = await redis.get(`mcp:at:${token}`);
  return raw ? { userId: (JSON.parse(raw) as { userId: string }).userId } : null;
}

export async function consumeRefresh(token: string) {
  const redis = await connectRedis();
  const raw = await redis.getDel(`mcp:rt:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as { userId: string; clientId: string; scope: string };
}
