-- Source and bundle bytes live in the same transaction as their immutable revision.
-- No FK to sessions: the legacy session writer uses INSERT OR REPLACE.
CREATE TABLE agent_artifacts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  head_revision_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_artifacts_session ON agent_artifacts(session_id, deleted_at);
CREATE TABLE agent_artifact_revisions (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_json TEXT NOT NULL, source_json TEXT NOT NULL, bundle_html TEXT NOT NULL,
  source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, stored_bytes INTEGER NOT NULL CHECK(stored_bytes >= 0),
  compiler_version INTEGER NOT NULL, policy_version INTEGER NOT NULL, sdk_version INTEGER NOT NULL,
  dependencies_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  UNIQUE(artifact_id, revision_number)
);
CREATE INDEX idx_artifact_revisions_session ON agent_artifact_revisions(session_id, artifact_id);
CREATE TRIGGER immutable_artifact_revision BEFORE UPDATE ON agent_artifact_revisions BEGIN
  SELECT RAISE(ABORT, 'artifact revisions are immutable');
END;
CREATE TABLE agent_artifact_state (
  revision_id TEXT PRIMARY KEY REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, state_json TEXT NOT NULL, etag INTEGER NOT NULL CHECK(etag >= 0)
);
CREATE TABLE agent_artifact_builds (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, artifact_id TEXT,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
  context_json TEXT NOT NULL, snapshot_json TEXT, snapshot_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed')),
  revision_id TEXT REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  error_code TEXT, error_message TEXT, lease_until INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(session_id, idempotency_key)
);
CREATE INDEX idx_artifact_builds_lease ON agent_artifact_builds(status, lease_until);
CREATE TABLE agent_artifact_outbox (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX idx_artifact_outbox_pending ON agent_artifact_outbox(delivered_at, created_at);
-- Session UPDATE/REPLACE must preserve revisions; explicit deletions clean up. SQLite's
-- default recursive_triggers=OFF prevents REPLACE's implicit delete from firing this.
CREATE TRIGGER delete_session_artifacts AFTER DELETE ON agent_runtime_sessions BEGIN
  DELETE FROM agent_artifact_builds WHERE session_id = OLD.id;
  DELETE FROM agent_artifacts WHERE session_id = OLD.id;
END;
