CREATE TABLE IF NOT EXISTS agent_runtime_work (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_work_session ON agent_runtime_work(session_id);
CREATE TABLE IF NOT EXISTS agent_runtime_aux_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  purpose TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_aux_usage_session ON agent_runtime_aux_usage(session_id);
