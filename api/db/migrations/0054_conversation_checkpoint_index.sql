-- This root pins the visible checkpoint prefix independently of conversation
-- content. Rollback trims its tree path rather than deleting checkpoint rows.
ALTER TABLE conversation_v3_heads ADD COLUMN checkpoint_root BLOB
  REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT;
ALTER TABLE conversation_v3_heads ADD COLUMN next_checkpoint INTEGER NOT NULL DEFAULT 1
  CHECK(next_checkpoint BETWEEN 1 AND 9007199254740991);
CREATE TRIGGER conversation_v3_checkpoint_root AFTER UPDATE OF checkpoint_root ON conversation_v3_heads
  WHEN NEW.checkpoint_root IS NOT OLD.checkpoint_root BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.checkpoint_root;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.checkpoint_root;
END;
CREATE TRIGGER conversation_v3_checkpoint_root_insert AFTER INSERT ON conversation_v3_heads
  WHEN NEW.checkpoint_root IS NOT NULL BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.checkpoint_root;
END;
CREATE TRIGGER conversation_v3_checkpoint_root_delete AFTER DELETE ON conversation_v3_heads
  WHEN OLD.checkpoint_root IS NOT NULL BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.checkpoint_root;
END;
CREATE INDEX idx_conversation_v3_checkpoint_root ON conversation_v3_heads(checkpoint_root);
