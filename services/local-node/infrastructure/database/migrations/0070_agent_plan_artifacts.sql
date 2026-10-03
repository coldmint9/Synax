CREATE TABLE IF NOT EXISTS agent_plan_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  human_acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  execution_id TEXT,
  approved_run_id TEXT,
  approved_step_index INTEGER,
  approved_by_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_agent_plan_artifacts_session_revision
  ON agent_plan_artifacts(session_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_agent_plan_artifacts_project_updated
  ON agent_plan_artifacts(project_id, updated_at DESC);
