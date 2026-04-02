CREATE TABLE IF NOT EXISTS issue_workflows (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'reopened')),
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (project_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_workflows_project_state ON issue_workflows(project_id, state);
CREATE INDEX IF NOT EXISTS idx_issue_workflows_assigned_user_id ON issue_workflows(assigned_user_id);
