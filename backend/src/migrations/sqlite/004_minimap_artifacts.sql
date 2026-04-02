CREATE TABLE IF NOT EXISTS minimap_artifacts (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  release TEXT NOT NULL,
  dist TEXT,
  artifact_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_minimap_artifacts_release
  ON minimap_artifacts (org, project, release);

CREATE INDEX IF NOT EXISTS idx_minimap_artifacts_expiry
  ON minimap_artifacts (expires_at);
