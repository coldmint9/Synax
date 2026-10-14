-- Current transcript state. The single receipt contains no deleted content and
-- exists only to make the most recent destructive request retryable.
CREATE TABLE conversation_flat_heads (
  session_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 1,
  last_request_id TEXT,
  last_request_hash TEXT,
  last_result_json TEXT
);
CREATE INDEX idx_flat_message_page ON agent_runtime_messages(session_id,sequence,id);
CREATE INDEX idx_flat_step_time ON agent_runtime_run_steps(session_id,started_at,id);
CREATE INDEX idx_flat_event_time ON agent_runtime_events(session_id,timestamp,id);
CREATE INDEX idx_flat_permission_time ON agent_runtime_permissions(session_id,created_at,id);
