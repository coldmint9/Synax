CREATE TABLE artifact_jobs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_json TEXT NOT NULL,
 request_hash TEXT NOT NULL, context_json TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','building','ready','failed','cancelled')),
 revision_id TEXT, artifact_id TEXT, error_code TEXT, diagnostics_json TEXT NOT NULL DEFAULT '[]',
 attempt INTEGER NOT NULL DEFAULT 1, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(session_id,idempotency_key)
);
CREATE INDEX artifact_jobs_pending ON artifact_jobs(status,lease_until,created_at);
CREATE TRIGGER delete_session_artifact_jobs AFTER DELETE ON agent_runtime_sessions BEGIN
 DELETE FROM artifact_jobs WHERE session_id=OLD.id;
END;
