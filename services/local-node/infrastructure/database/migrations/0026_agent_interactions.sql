-- Runtime records use INSERT OR REPLACE; ownership is validated by the service,
-- and session-tree deletion explicitly removes these checkpoints. FK cascades
-- would incorrectly delete pending forms on ordinary runtime updates.
CREATE TABLE IF NOT EXISTS agent_runtime_interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('clarification', 'plan_approval')),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'declined', 'cancelled')),
  request_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_interactions_session ON agent_runtime_interactions(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_interactions_pending ON agent_runtime_interactions(session_id) WHERE status = 'pending';
