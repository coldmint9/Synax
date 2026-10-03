CREATE TABLE IF NOT EXISTS runtime_artifact_feedback (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES agent_runtime_sessions(id) ON DELETE CASCADE,
 revision_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 message TEXT NOT NULL,
 queue_item_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(session_id, idempotency_key)
);
