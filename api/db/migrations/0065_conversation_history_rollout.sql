-- A staging head is durable but never visible as the live session. Reads keep
-- using v2 until the final, atomic head publication. Copy progress is resumable.
CREATE TABLE conversation_v3_migrations (
  session_id TEXT PRIMARY KEY,
  staging_id TEXT NOT NULL UNIQUE,
  source_revision INTEGER NOT NULL,
  table_index INTEGER NOT NULL DEFAULT 0,
  after_rowid INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'copying' CHECK(state IN ('copying','cleanup','abandoned')),
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_migration_state ON conversation_v3_migrations(state,session_id);

ALTER TABLE conversation_v3_heads ADD COLUMN boundary_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_v3_heads ADD COLUMN runtime_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_v3_heads ADD COLUMN legacy_runtime INTEGER NOT NULL DEFAULT 0;
-- Small visibility locators, NOT snapshots of execution records. Actual run,
-- step, tool, permission and event data remain in their existing audit tables.
CREATE TABLE conversation_v3_runtime_records (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY(session_id,kind,record_id)
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_runtime_page ON conversation_v3_runtime_records(session_id,kind,epoch,sequence DESC);
CREATE TABLE conversation_v3_deletions (
  session_id TEXT PRIMARY KEY,
  phase INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_runtime_retention ON conversation_v3_runtime_records(session_id,kind,sequence DESC);
