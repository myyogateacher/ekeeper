import { config } from "../config";
import { one, run } from "../db/sqlite";
import { randomToken } from "./ids";
import type { ServerSettings } from "@ekeeper/shared";

const TOKEN_KEY = "ekeeper_auth_token";
const MCP_SECRET_KEY = "ekeeper_mcp_secret_key";

function now() {
  return new Date().toISOString();
}

function readSetting(key: string): string | undefined {
  return one<{ value: string }>("SELECT value FROM server_settings WHERE key = ?", [key])?.value;
}

function writeSetting(key: string, value: string) {
  run(
    `INSERT INTO server_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now()],
  );
}

export function getEkeeperUrl() {
  return config.APP_URL.replace(/\/+$/, "");
}

export function getServerAuthToken() {
  const existing = readSetting(TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomToken(24);
  writeSetting(TOKEN_KEY, token);
  return token;
}

export function regenerateServerAuthToken() {
  const token = randomToken(24);
  writeSetting(TOKEN_KEY, token);
  return token;
}

// Global MCP secret key: an alternative to the OAuth flow for MCP clients that
// can send a static Authorization header. Grants read access to all active
// projects. Auto-generated on first read; regeneratable by admins. The `mcpk_`
// prefix lets the MCP endpoint route these tokens to key validation.
function newMcpKey() {
  return `mcpk_${randomToken(24)}`;
}

export function getMcpSecretKey() {
  const existing = readSetting(MCP_SECRET_KEY);
  if (existing) {
    return existing;
  }
  const key = newMcpKey();
  writeSetting(MCP_SECRET_KEY, key);
  return key;
}

export function regenerateMcpSecretKey() {
  const key = newMcpKey();
  writeSetting(MCP_SECRET_KEY, key);
  return key;
}

export function getServerSettings(): ServerSettings {
  return {
    ekeeperOrg: config.EKEEPER_ORG,
    ekeeperUrl: getEkeeperUrl(),
    ekeeperAuthToken: getServerAuthToken(),
  };
}
