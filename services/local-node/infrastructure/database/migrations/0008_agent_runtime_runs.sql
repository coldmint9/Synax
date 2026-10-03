-- ---------------------------------------------------------------------------
-- 0008_agent_runtime_runs.sql — Loop-native agent runtime persistence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_runtime_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  trigger_message_id TEXT,
  current_step INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  model TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_arr_session_started ON agent_runtime_runs(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  finish_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arrs_run_step_index ON agent_runtime_run_steps(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_arrs_session_run ON agent_runtime_run_steps(session_id, run_id, step_index);

CREATE TABLE IF NOT EXISTS agent_runtime_run_parts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arrp_step_sequence ON agent_runtime_run_parts(step_id, sequence);
CREATE INDEX IF NOT EXISTS idx_arrp_run_step ON agent_runtime_run_parts(run_id, step_id, sequence);
