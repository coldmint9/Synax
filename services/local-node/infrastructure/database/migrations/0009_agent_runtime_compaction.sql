-- 0009_agent_runtime_compaction.sql — Context compaction summaries for agent runtime.

CREATE TABLE IF NOT EXISTS agent_runtime_compaction_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  summary_text TEXT NOT NULL,
  compressed_message_count INTEGER NOT NULL DEFAULT 0,
  original_token_count INTEGER NOT NULL DEFAULT 0,
  compressed_token_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_arcs_session ON agent_runtime_compaction_summaries(session_id, created_at DESC);
