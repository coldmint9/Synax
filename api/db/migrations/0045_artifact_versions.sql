-- Revision-owned metadata deliberately has no session FK: session checkpoints use REPLACE.
CREATE TABLE agent_artifact_control_schemas (
  revision_id TEXT PRIMARY KEY REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER immutable_artifact_control_schema BEFORE UPDATE ON agent_artifact_control_schemas BEGIN
  SELECT RAISE(ABORT, 'artifact control schemas are immutable');
END;
CREATE TABLE agent_artifact_lineage (
  artifact_id TEXT PRIMARY KEY REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  first_revision_id TEXT NOT NULL UNIQUE REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  source_revision_id TEXT NOT NULL REFERENCES agent_artifact_revisions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, idempotency_key)
);
CREATE INDEX idx_artifact_lineage_source ON agent_artifact_lineage(session_id, source_revision_id);
CREATE TRIGGER immutable_artifact_lineage BEFORE UPDATE ON agent_artifact_lineage BEGIN
  SELECT RAISE(ABORT, 'artifact lineage is immutable');
END;
