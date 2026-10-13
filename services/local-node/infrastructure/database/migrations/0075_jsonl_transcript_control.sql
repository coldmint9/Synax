-- JSONL transcript control plane. Bodies stay append-only; visibility is mutable SQLite state.
CREATE TABLE IF NOT EXISTS transcript_heads (
  -- Session upserts currently use REPLACE. A cascading FK would erase history
  -- during ordinary status updates. Deletion must be explicit in the adapter.
  session_id TEXT PRIMARY KEY,
  segment TEXT NOT NULL UNIQUE,
  visible_sequence INTEGER NOT NULL DEFAULT 0 CHECK(visible_sequence >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(committed_bytes >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0),
  storage_mode TEXT NOT NULL DEFAULT 'jsonl' CHECK(storage_mode='jsonl'),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_records (
  session_id TEXT NOT NULL REFERENCES transcript_heads(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  offset INTEGER NOT NULL CHECK(offset >= 0),
  length INTEGER NOT NULL CHECK(length > 0),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
  hash TEXT NOT NULL CHECK(length(hash)=64),
  kind TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, message_id),
  UNIQUE(session_id, sequence),
  UNIQUE(session_id, offset)
);
CREATE INDEX IF NOT EXISTS idx_transcript_records_visible
  ON transcript_records(session_id, visible, sequence);
CREATE INDEX IF NOT EXISTS idx_transcript_records_hash
  ON transcript_records(hash);
