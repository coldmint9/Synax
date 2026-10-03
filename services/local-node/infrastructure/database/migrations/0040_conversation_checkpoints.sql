-- History checkpoints are independent from task/work checkpoints and project Git.
CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message_id TEXT,
  step_id TEXT,
  mutation_cursor INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_conversation_checkpoint_session ON conversation_checkpoints(session_id);
CREATE TABLE IF NOT EXISTS conversation_mutations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  roots_json TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  uncertain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_history_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_workspace_locks (
  root TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_history_versions (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);
