-- Small control-plane state; immutable history is referenced, never copied here.
CREATE TABLE IF NOT EXISTS conversation_v3_heads (
  session_id TEXT PRIMARY KEY CHECK(length(session_id) BETWEEN 1 AND 256),
  version_id TEXT NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch BETWEEN 1 AND 9007199254740991)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_conversation_v3_heads_version ON conversation_v3_heads(version_id);

-- Ownership proofs are NOT GC pins. Checkpoints/readers/heads pin independently.
-- Collecting an unpinned old version removes its proof rather than retaining it forever.
CREATE TABLE IF NOT EXISTS conversation_v3_owned_versions (
  session_id TEXT NOT NULL REFERENCES conversation_v3_heads(session_id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE CASCADE,
  PRIMARY KEY(session_id,version_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_conversation_v3_owned_version ON conversation_v3_owned_versions(version_id,session_id);

CREATE TABLE IF NOT EXISTS conversation_v3_operations (
  session_id TEXT NOT NULL REFERENCES conversation_v3_heads(session_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  result_session_id TEXT NOT NULL,
  result_version_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  result_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT(unixepoch()),
  PRIMARY KEY(session_id,request_id)
) WITHOUT ROWID;
