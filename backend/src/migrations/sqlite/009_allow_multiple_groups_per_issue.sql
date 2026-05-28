DROP INDEX IF EXISTS idx_error_group_github_issues_lookup;

CREATE INDEX IF NOT EXISTS idx_error_group_github_issues_by_issue
  ON error_group_github_issues(project_id, github_issue_number);
