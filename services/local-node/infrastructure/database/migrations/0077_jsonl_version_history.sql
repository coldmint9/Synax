-- Immutable JSONL payload packs. Object identities and historical version roots
-- do not change when inline/binary payloads are physically migrated.
CREATE TABLE IF NOT EXISTS jsonl_payload_segments (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(committed_bytes>=0),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
CREATE TABLE IF NOT EXISTS jsonl_payload_heads (
  owner TEXT PRIMARY KEY,
  segment TEXT NOT NULL REFERENCES jsonl_payload_segments(id)
);
CREATE TABLE IF NOT EXISTS jsonl_payload_records (
  hash TEXT PRIMARY KEY CHECK(length(hash)=64),
  segment TEXT NOT NULL REFERENCES jsonl_payload_segments(id),
  offset INTEGER NOT NULL CHECK(offset>=0),
  length INTEGER NOT NULL CHECK(length>0),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0)
);
CREATE INDEX IF NOT EXISTS idx_jsonl_payload_segment ON jsonl_payload_records(segment);
ALTER TABLE conversation_v3_heads ADD COLUMN full_history INTEGER NOT NULL DEFAULT 0 CHECK(full_history IN (0,1));
CREATE TABLE IF NOT EXISTS jsonl_history_migrations (
  session_id TEXT PRIMARY KEY,
  source_backend TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_version_id TEXT,
  source_cursor TEXT,
  verified_count INTEGER NOT NULL DEFAULT 0,
  after_sequence INTEGER NOT NULL DEFAULT 0,
  after_rowid INTEGER NOT NULL DEFAULT 0,
  copied_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'copying' CHECK(state IN ('copying','verified','published')),
  updated_at TEXT NOT NULL,
  error TEXT
);
ALTER TABLE conversation_v3_objects ADD COLUMN jsonl_payload INTEGER NOT NULL DEFAULT 0 CHECK(jsonl_payload IN (0,1));
CREATE INDEX IF NOT EXISTS idx_v3_pending_jsonl ON conversation_v3_objects(hash) WHERE jsonl_payload=0;
-- Used to distinguish a physically migrated session from a process-local flag.
CREATE TABLE IF NOT EXISTS session_history_storage (
  session_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL CHECK(backend='jsonl-v3'),
  migrated_at TEXT NOT NULL,
  source_backend TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jsonl_checkpoint_aliases (
  session_id TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,old_id)
);
-- Child history can use the same physical JSONL store, but is never exposed as
-- an independently rollbackable root. Reject older, unported child writers.
DROP TRIGGER IF EXISTS version_transcript_root_head;
CREATE TRIGGER version_transcript_root_head BEFORE INSERT ON conversation_v3_heads
WHEN EXISTS(SELECT 1 FROM agent_runtime_sessions WHERE id=NEW.session_id AND parent_session_id IS NOT NULL)
  AND NOT (NEW.full_history=1 AND NEW.runtime_mode='native' AND NEW.rollback_enabled=0)
BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
