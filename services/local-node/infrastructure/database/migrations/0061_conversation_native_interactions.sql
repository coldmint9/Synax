ALTER TABLE agent_runtime_interactions ADD COLUMN version_epoch INTEGER;
CREATE INDEX idx_interactions_current_epoch ON agent_runtime_interactions(session_id,version_epoch,status,consumed_at);
DROP TRIGGER version_transcript_agent_runtime_interactions_insert;
DROP TRIGGER version_transcript_agent_runtime_interactions_update;
DROP TRIGGER version_transcript_agent_runtime_interactions_delete;
CREATE TRIGGER version_transcript_agent_runtime_interactions_insert BEFORE INSERT ON agent_runtime_interactions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
CREATE TRIGGER version_transcript_agent_runtime_interactions_update BEFORE UPDATE ON agent_runtime_interactions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
CREATE TRIGGER version_transcript_agent_runtime_interactions_delete BEFORE DELETE ON agent_runtime_interactions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
-- Ready-input lookup must not scan already-consumed historical forms.
CREATE INDEX idx_interactions_unconsumed_epoch
 ON agent_runtime_interactions(session_id,version_epoch,run_id,status)
 WHERE consumed_at IS NULL;
