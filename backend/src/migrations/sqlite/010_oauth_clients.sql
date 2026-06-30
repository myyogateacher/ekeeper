CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,         -- JSON array
  client_name   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
