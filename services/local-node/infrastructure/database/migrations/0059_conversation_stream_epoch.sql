-- Stream journal is a live execution transport, not the immutable transcript.
-- Old generations remain available only for bounded maintenance/audit, never replay.
ALTER TABLE agent_runtime_stream_records ADD COLUMN version_epoch INTEGER;
CREATE INDEX idx_stream_version_epoch ON agent_runtime_stream_records(session_id,version_epoch,sequence);
