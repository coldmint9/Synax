-- Keep object identities, roots and checkpoints. Inline objects remain readable
-- while bounded migration publishes immutable file payloads.
ALTER TABLE conversation_v3_objects ADD COLUMN payload_ref TEXT
  CHECK(payload_ref IS NULL OR (length(payload_ref)=64 AND payload_ref NOT GLOB '*[^a-f0-9]*'));
DROP TRIGGER conversation_v3_objects_immutable;
CREATE TRIGGER conversation_v3_objects_immutable
  BEFORE UPDATE OF hash,kind,payload,refs,logical_bytes,payload_ref ON conversation_v3_objects
  WHEN NOT (
    OLD.payload_ref IS NULL AND NEW.payload_ref IS NOT NULL AND length(NEW.payload)=0
    AND NEW.hash=OLD.hash AND NEW.kind=OLD.kind AND NEW.refs=OLD.refs
    AND NEW.logical_bytes=OLD.logical_bytes
  )
  BEGIN SELECT RAISE(ABORT,'VERSION_IMMUTABLE_OBJECT'); END;
CREATE INDEX idx_conversation_v3_inline_payload ON conversation_v3_objects(hash) WHERE payload_ref IS NULL;
CREATE INDEX idx_conversation_v3_payload_ref ON conversation_v3_objects(payload_ref) WHERE payload_ref IS NOT NULL;
CREATE TABLE conversation_v3_payload_gc (
  payload_ref TEXT PRIMARY KEY, queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER conversation_v3_payload_gc_enqueue AFTER DELETE ON conversation_v3_objects
  WHEN OLD.payload_ref IS NOT NULL BEGIN
    INSERT OR IGNORE INTO conversation_v3_payload_gc(payload_ref) VALUES(OLD.payload_ref);
END;
