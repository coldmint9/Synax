-- Capture identity has its own structurally shared root. Locators do NOT pin
-- business versions; checkpoints reference their lookup-before root for rollback.
ALTER TABLE conversation_v3_heads ADD COLUMN checkpoint_identity_root BLOB
  REFERENCES conversation_v3_objects(hash) ON DELETE RESTRICT;
CREATE INDEX idx_conversation_v3_checkpoint_identity_root ON conversation_v3_heads(checkpoint_identity_root);
CREATE TRIGGER conversation_v3_checkpoint_identity_root AFTER UPDATE OF checkpoint_identity_root ON conversation_v3_heads
  WHEN NEW.checkpoint_identity_root IS NOT OLD.checkpoint_identity_root BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.checkpoint_identity_root;
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.checkpoint_identity_root;
END;
CREATE TRIGGER conversation_v3_checkpoint_identity_insert AFTER INSERT ON conversation_v3_heads
  WHEN NEW.checkpoint_identity_root IS NOT NULL BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=NEW.checkpoint_identity_root;
END;
CREATE TRIGGER conversation_v3_checkpoint_identity_delete AFTER DELETE ON conversation_v3_heads
  WHEN OLD.checkpoint_identity_root IS NOT NULL BEGIN
  UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=OLD.checkpoint_identity_root;
END;
