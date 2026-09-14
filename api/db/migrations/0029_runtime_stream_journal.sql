-- Transport replay, not another execution-state ledger. Session upserts cannot reset this cursor.
CREATE TABLE IF NOT EXISTS agent_runtime_stream_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  chunk_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arsr_session_sequence ON agent_runtime_stream_records(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_arsr_run_sequence ON agent_runtime_stream_records(run_id, sequence);
