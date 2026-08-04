-- Retention cleanup and the eligible-count shown on the minimaps page scan the whole
-- table on every request. Index the age filter and the per-project release ranking.
CREATE INDEX IF NOT EXISTS idx_minimap_artifacts_uploaded_at
  ON minimap_artifacts (uploaded_at);

CREATE INDEX IF NOT EXISTS idx_minimap_artifacts_project_release_uploaded
  ON minimap_artifacts (project_id, release, uploaded_at);
