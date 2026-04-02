CREATE TABLE IF NOT EXISTS sentry_releases (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project_slug TEXT,
  version TEXT NOT NULL,
  date_created TEXT NOT NULL,
  date_released TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sentry_releases_org_project_version
  ON sentry_releases (org, COALESCE(project_slug, ''), version);
