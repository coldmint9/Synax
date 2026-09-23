ALTER TABLE conversation_v3_heads ADD COLUMN rollback_enabled INTEGER NOT NULL DEFAULT 1 CHECK(rollback_enabled IN (0,1));
CREATE TRIGGER conversation_append_only_checkpoint BEFORE UPDATE OF checkpoint_root ON conversation_v3_heads
 WHEN NEW.rollback_enabled=0 AND NEW.checkpoint_root IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'HISTORY_APPEND_ONLY'); END;
CREATE TRIGGER conversation_append_only_epoch BEFORE UPDATE OF epoch ON conversation_v3_heads
 WHEN OLD.rollback_enabled=0 AND NEW.epoch<>OLD.epoch
 BEGIN SELECT RAISE(ABORT,'HISTORY_APPEND_ONLY'); END;
CREATE TRIGGER conversation_append_only_policy BEFORE UPDATE OF rollback_enabled ON conversation_v3_heads
 WHEN OLD.rollback_enabled=0 AND NEW.rollback_enabled<>0
 BEGIN SELECT RAISE(ABORT,'HISTORY_APPEND_ONLY'); END;
