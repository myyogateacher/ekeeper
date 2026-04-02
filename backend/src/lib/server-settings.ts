import { config } from "../config";
import { one, run } from "../db/sqlite";
import { randomToken } from "./ids";
import type { ServerSettings } from "@ekeeper/shared";

const TOKEN_KEY = "ekeeper_auth_token";

function now() {
  return new Date().toISOString();
}

export function getEkeeperUrl() {
  return config.APP_URL.replace(/\/+$/, "");
}

export function getServerAuthToken() {
  const existing = one<{ value: string }>(
    "SELECT value FROM server_settings WHERE key = ?",
    [TOKEN_KEY],
  );

  if (existing?.value) {
    return existing.value;
  }

  const token = randomToken(24);
  run(
    `INSERT INTO server_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [TOKEN_KEY, token, now()],
  );
  return token;
}

export function regenerateServerAuthToken() {
  const token = randomToken(24);
  run(
    `INSERT INTO server_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [TOKEN_KEY, token, now()],
  );
  return token;
}

export function getServerSettings(): ServerSettings {
  return {
    ekeeperOrg: config.EKEEPER_ORG,
    ekeeperUrl: getEkeeperUrl(),
    ekeeperAuthToken: getServerAuthToken(),
  };
}
