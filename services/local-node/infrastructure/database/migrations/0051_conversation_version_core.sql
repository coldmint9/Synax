-- Opt-in immutable history storage. No live session is converted by this migration.
CREATE TABLE IF NOT EXISTS conversation_v3_objects (
  hash TEXT PRIMARY KEY CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('chunk','tree','record','version')),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)<=65536
    AND (kind='chunk' OR length(payload)<=16384)
    AND (kind<>'version' OR length(payload)<=4096)),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=length(payload))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS conversation_v3_edges (
  source_hash TEXT NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE CASCADE,
  target_hash TEXT NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT,
  PRIMARY KEY(source_hash,target_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_conversation_v3_edges_target
  ON conversation_v3_edges(target_hash,source_hash);

CREATE TABLE IF NOT EXISTS conversation_v3_storage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  objects INTEGER NOT NULL DEFAULT 0 CHECK(objects>=0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0)
);
INSERT OR IGNORE INTO conversation_v3_storage(id) VALUES(1);
