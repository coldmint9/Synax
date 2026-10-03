-- Replace only the EMPTY, unpublished version-core prototype. Production v2
-- tables are untouched. A populated prototype requires explicit offline migration.
CREATE TABLE conversation_v3_compact_guard (
  empty INTEGER CONSTRAINT populated_prototype_requires_explicit_migration CHECK(empty=1)
);
INSERT INTO conversation_v3_compact_guard VALUES(CASE WHEN
  EXISTS(SELECT 1 FROM conversation_v3_objects LIMIT 1) OR
  EXISTS(SELECT 1 FROM conversation_v3_heads LIMIT 1) OR
  EXISTS(SELECT 1 FROM conversation_v3_operations LIMIT 1) OR
  EXISTS(SELECT 1 FROM conversation_v3_owned_versions LIMIT 1) OR
  EXISTS(SELECT 1 FROM conversation_v3_edges LIMIT 1) OR
  EXISTS(SELECT 1 FROM conversation_v3_storage WHERE objects<>0 OR bytes<>0)
  THEN 0 ELSE 1 END);
DROP TABLE conversation_v3_compact_guard;
DROP TABLE conversation_v3_operations;
DROP TABLE conversation_v3_owned_versions;
DROP TABLE conversation_v3_heads;
DROP TABLE conversation_v3_edges;
DROP TABLE conversation_v3_objects;
DROP TABLE conversation_v3_storage;

CREATE TABLE conversation_v3_storage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  format INTEGER NOT NULL DEFAULT 2 CHECK(format=2),
  objects INTEGER NOT NULL DEFAULT 0 CHECK(objects>=0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),
  metadata_bytes INTEGER NOT NULL DEFAULT 0 CHECK(metadata_bytes>=0),
  metadata_limit INTEGER NOT NULL DEFAULT 67108864 CHECK(metadata_limit BETWEEN 1 AND 9007199254740991)
);
INSERT INTO conversation_v3_storage(id) VALUES(1);

CREATE TABLE conversation_v3_objects (
  hash BLOB PRIMARY KEY CHECK(typeof(hash)='blob' AND length(hash)=32),
  kind TEXT NOT NULL CHECK(kind IN ('chunk','tree','record','version')),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)<=65536
    AND (kind='chunk' OR length(payload)<=16384)
    AND (kind<>'version' OR length(payload)<=4096)),
  refs BLOB NOT NULL CHECK(typeof(refs)='blob' AND length(refs)<=8192 AND length(refs)%32=0),
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count BETWEEN 0 AND 9007199254740991),
  logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=length(payload)+length(refs))
) WITHOUT ROWID;
-- A persistent bounded work queue: roots with no parents/pins become candidates.
CREATE INDEX idx_conversation_v3_unreferenced ON conversation_v3_objects(hash) WHERE ref_count=0;
CREATE TRIGGER conversation_v3_objects_immutable
  BEFORE UPDATE OF hash,kind,payload,refs,logical_bytes ON conversation_v3_objects BEGIN
  SELECT RAISE(ABORT,'VERSION_IMMUTABLE_OBJECT');
END;
CREATE TRIGGER conversation_v3_objects_protected BEFORE DELETE ON conversation_v3_objects
  WHEN OLD.ref_count<>0 BEGIN SELECT RAISE(ABORT,'VERSION_OBJECT_REFERENCED'); END;
CREATE TRIGGER conversation_v3_objects_removed AFTER DELETE ON conversation_v3_objects BEGIN
  UPDATE conversation_v3_storage SET objects=objects-1,bytes=bytes-OLD.logical_bytes WHERE id=1;
END;

CREATE TABLE conversation_v3_heads (
  session_id TEXT PRIMARY KEY CHECK(length(CAST(session_id AS BLOB)) BETWEEN 1 AND 256),
  version_id BLOB NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch BETWEEN 1 AND 9007199254740991)
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_heads_version ON conversation_v3_heads(version_id);

-- Weak ownership proofs are deleted in bounded pages BEFORE collecting a version.
-- RESTRICT avoids an unbounded FK cascade when thousands of sessions shared it.
CREATE TABLE conversation_v3_owned_versions (
  session_id TEXT NOT NULL REFERENCES conversation_v3_heads(session_id) ON DELETE RESTRICT,
  version_id BLOB NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT,
  PRIMARY KEY(session_id,version_id)
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_owned_version ON conversation_v3_owned_versions(version_id,session_id);

CREATE TABLE conversation_v3_operations (
  session_id TEXT NOT NULL REFERENCES conversation_v3_heads(session_id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK(length(CAST(request_id AS BLOB)) BETWEEN 1 AND 256),
  body_hash BLOB NOT NULL CHECK(typeof(body_hash)='blob' AND length(body_hash)=32),
  result_session_id TEXT NOT NULL CHECK(length(CAST(result_session_id AS BLOB)) BETWEEN 1 AND 256),
  result_version_id BLOB NOT NULL CHECK(typeof(result_version_id)='blob' AND length(result_version_id)=32),
  result_revision INTEGER NOT NULL,
  result_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT(unixepoch()),
  PRIMARY KEY(session_id,request_id)
) WITHOUT ROWID;

CREATE TABLE conversation_v3_pins (
  id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 256),
  object_id BLOB NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','reader','writer','recovery','fork')),
  owner TEXT NOT NULL CHECK(length(CAST(owner AS BLOB)) BETWEEN 1 AND 256)
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_pins_owner ON conversation_v3_pins(owner,id);
CREATE INDEX idx_conversation_v3_pins_object ON conversation_v3_pins(object_id);

-- AFTER INSERT does not double-charge INSERT OR IGNORE/idempotent duplicates.
CREATE TRIGGER conversation_v3_heads_insert AFTER INSERT ON conversation_v3_heads BEGIN
  SELECT CASE WHEN (SELECT metadata_bytes+(192+length(CAST(NEW.session_id AS BLOB)))>metadata_limit FROM conversation_v3_storage WHERE id=1)
    THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+(192+length(CAST(NEW.session_id AS BLOB))) WHERE id=1;
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.version_id;
END;
CREATE TRIGGER conversation_v3_heads_delete AFTER DELETE ON conversation_v3_heads BEGIN
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-(192+length(CAST(OLD.session_id AS BLOB))) WHERE id=1;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.version_id;
END;
CREATE TRIGGER conversation_v3_heads_root AFTER UPDATE OF version_id ON conversation_v3_heads
  WHEN NEW.version_id IS NOT OLD.version_id BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.version_id;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.version_id;
END;

-- AFTER INSERT does not double-charge INSERT OR IGNORE/idempotent duplicates.
CREATE TRIGGER conversation_v3_owned_versions_insert AFTER INSERT ON conversation_v3_owned_versions BEGIN
  SELECT CASE WHEN (SELECT metadata_bytes+(128+length(CAST(NEW.session_id AS BLOB)))>metadata_limit FROM conversation_v3_storage WHERE id=1)
    THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+(128+length(CAST(NEW.session_id AS BLOB))) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_owned_versions_delete AFTER DELETE ON conversation_v3_owned_versions BEGIN
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-(128+length(CAST(OLD.session_id AS BLOB))) WHERE id=1;
END;

-- AFTER INSERT does not double-charge INSERT OR IGNORE/idempotent duplicates.
CREATE TRIGGER conversation_v3_operations_insert AFTER INSERT ON conversation_v3_operations BEGIN
  SELECT CASE WHEN (SELECT metadata_bytes+(320+length(CAST(NEW.session_id AS BLOB))+length(CAST(NEW.request_id AS BLOB))+length(CAST(NEW.result_session_id AS BLOB)))>metadata_limit FROM conversation_v3_storage WHERE id=1)
    THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+(320+length(CAST(NEW.session_id AS BLOB))+length(CAST(NEW.request_id AS BLOB))+length(CAST(NEW.result_session_id AS BLOB))) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_operations_delete AFTER DELETE ON conversation_v3_operations BEGIN
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-(320+length(CAST(OLD.session_id AS BLOB))+length(CAST(OLD.request_id AS BLOB))+length(CAST(OLD.result_session_id AS BLOB))) WHERE id=1;
END;

-- AFTER INSERT does not double-charge INSERT OR IGNORE/idempotent duplicates.
CREATE TRIGGER conversation_v3_pins_insert AFTER INSERT ON conversation_v3_pins BEGIN
  SELECT CASE WHEN (SELECT metadata_bytes+(256+length(CAST(NEW.id AS BLOB))+length(CAST(NEW.owner AS BLOB))+length(CAST(NEW.kind AS BLOB)))>metadata_limit FROM conversation_v3_storage WHERE id=1)
    THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+(256+length(CAST(NEW.id AS BLOB))+length(CAST(NEW.owner AS BLOB))+length(CAST(NEW.kind AS BLOB))) WHERE id=1;
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.object_id;
END;
CREATE TRIGGER conversation_v3_pins_delete AFTER DELETE ON conversation_v3_pins BEGIN
  UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-(256+length(CAST(OLD.id AS BLOB))+length(CAST(OLD.owner AS BLOB))+length(CAST(OLD.kind AS BLOB))) WHERE id=1;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.object_id;
END;
CREATE TRIGGER conversation_v3_pins_root AFTER UPDATE OF object_id ON conversation_v3_pins
  WHEN NEW.object_id IS NOT OLD.object_id BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.object_id;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.object_id;
END;

-- Charged identities are immutable; changes must release/recreate a row so the
-- byte ledger cannot drift. Root swaps are fixed-size and handled separately.
CREATE TRIGGER conversation_v3_heads_identity BEFORE UPDATE OF session_id ON conversation_v3_heads BEGIN
  SELECT RAISE(ABORT,'VERSION_IMMUTABLE_IDENTITY'); END;
CREATE TRIGGER conversation_v3_owned_identity BEFORE UPDATE ON conversation_v3_owned_versions BEGIN
  SELECT RAISE(ABORT,'VERSION_IMMUTABLE_IDENTITY'); END;
CREATE TRIGGER conversation_v3_operations_immutable BEFORE UPDATE ON conversation_v3_operations BEGIN
  SELECT RAISE(ABORT,'VERSION_IMMUTABLE_OPERATION'); END;
CREATE TRIGGER conversation_v3_pins_identity BEFORE UPDATE OF id,kind,owner ON conversation_v3_pins BEGIN
  SELECT RAISE(ABORT,'VERSION_IMMUTABLE_IDENTITY'); END;
