DROP TRIGGER version_transcript_agent_runtime_events_insert;
CREATE TRIGGER version_transcript_agent_runtime_events_insert BEFORE INSERT ON agent_runtime_events
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_events_update;
CREATE TRIGGER version_transcript_agent_runtime_events_update BEFORE UPDATE ON agent_runtime_events
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND boundary_only=0) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_events_delete;
CREATE TRIGGER version_transcript_agent_runtime_events_delete BEFORE DELETE ON agent_runtime_events
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_asset_sessions_insert;
CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_insert BEFORE INSERT ON agent_runtime_asset_sessions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_asset_sessions_update;
CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_update BEFORE UPDATE ON agent_runtime_asset_sessions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND boundary_only=0) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_asset_sessions_delete;
CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_delete BEFORE DELETE ON agent_runtime_asset_sessions
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND boundary_only=0) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

DROP TRIGGER version_transcript_agent_runtime_messages_delete;
CREATE TRIGGER version_transcript_agent_runtime_messages_delete BEFORE DELETE ON agent_runtime_messages
 WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM conversation_v3_deletions WHERE session_id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM conversation_v3_migrations WHERE session_id=OLD.session_id AND state='cleanup')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE INDEX idx_conversation_live_run_epoch ON agent_runtime_runs(session_id,version_epoch,status);

-- Fail closed if an older full-runtime writer opens a lightweight session.
CREATE TRIGGER conversation_boundary_no_runtime_snapshots BEFORE INSERT ON conversation_v3_objects
WHEN CASE WHEN NEW.kind='record' AND json_valid(CAST(NEW.payload AS TEXT)) THEN
  json_extract(CAST(NEW.payload AS TEXT),'$.kind')='runtime-record'
  AND json_extract(CAST(NEW.payload AS TEXT),'$.table') IN ('events','runs','steps','parts','tools','permissions','artifacts','thinking','interactions')
  AND EXISTS(SELECT 1 FROM conversation_v3_heads WHERE boundary_only=1 AND session_id=json_extract(CAST(NEW.payload AS TEXT),'$.scope'))
ELSE 0 END
BEGIN SELECT RAISE(ABORT,'HISTORY_BOUNDARY_CLIENT_REQUIRED'); END;
