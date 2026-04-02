CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE minimap_artifacts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

UPDATE minimap_artifacts
SET project_id = (
  SELECT id FROM projects WHERE projects.slug = minimap_artifacts.project
)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_minimap_artifacts_project_release
  ON minimap_artifacts (project_id, release);
