CREATE TABLE IF NOT EXISTS project_github_integrations (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  default_labels TEXT NOT NULL DEFAULT '[]',
  webhook_secret TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_group_github_issues (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  github_issue_number INTEGER NOT NULL,
  github_issue_url TEXT NOT NULL,
  github_node_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, group_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_error_group_github_issues_lookup
  ON error_group_github_issues(project_id, github_issue_number);
