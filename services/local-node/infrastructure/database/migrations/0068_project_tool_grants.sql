-- Tool-specific, project-wide approvals. Deleting a row revokes future executions.
CREATE TABLE IF NOT EXISTS agent_project_tool_grants (
  project_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tool_id)
);
