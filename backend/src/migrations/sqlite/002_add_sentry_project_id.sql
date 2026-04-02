ALTER TABLE projects ADD COLUMN sentry_project_id TEXT;

UPDATE projects
SET sentry_project_id = CAST(rowid AS TEXT)
WHERE sentry_project_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_sentry_project_id ON projects(sentry_project_id);
