-- Session persistence uses INSERT OR REPLACE. A cascading FK treats REPLACE as
-- DELETE and destroys feedback deduplication during ordinary session updates.
CREATE TEMP TABLE runtime_artifact_feedback_legacy AS SELECT * FROM runtime_artifact_feedback;
DROP TABLE runtime_artifact_feedback;
CREATE TABLE runtime_artifact_feedback (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
 message TEXT NOT NULL, queue_item_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(session_id, idempotency_key)
);
INSERT INTO runtime_artifact_feedback SELECT * FROM runtime_artifact_feedback_legacy;
DROP TABLE runtime_artifact_feedback_legacy;
CREATE TRIGGER delete_session_artifact_feedback AFTER DELETE ON agent_runtime_sessions BEGIN
 DELETE FROM runtime_artifact_feedback WHERE session_id = OLD.id;
END;
