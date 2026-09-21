CREATE TABLE artifact_publication_requests (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, input_json TEXT NOT NULL,
 run_id TEXT, step_id TEXT, status TEXT NOT NULL DEFAULT 'pending', revision_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX artifact_publication_session ON artifact_publication_requests(session_id);
CREATE TRIGGER delete_session_artifact_requests AFTER DELETE ON agent_runtime_sessions BEGIN
 DELETE FROM artifact_publication_requests WHERE session_id=OLD.id;
END;
