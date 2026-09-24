ALTER TABLE agent_runtime_sessions ADD COLUMN archived_at TEXT;
ALTER TABLE agent_runtime_sessions ADD COLUMN archive_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ars_archive_batch
  ON agent_runtime_sessions(archived_at DESC, archive_batch_id);
