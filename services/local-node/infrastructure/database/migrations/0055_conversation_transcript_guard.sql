-- Experimental transcript-only cohort; do not allow unported writers to create
-- history that the version reader/rollback path would silently miss.

CREATE TRIGGER version_transcript_agent_runtime_messages_insert BEFORE INSERT ON agent_runtime_messages
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_messages_update BEFORE UPDATE ON agent_runtime_messages
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_messages_delete BEFORE DELETE ON agent_runtime_messages
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_events_insert BEFORE INSERT ON agent_runtime_events
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_events_update BEFORE UPDATE ON agent_runtime_events
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_events_delete BEFORE DELETE ON agent_runtime_events
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_runs_insert BEFORE INSERT ON agent_runtime_runs
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_runs_update BEFORE UPDATE ON agent_runtime_runs
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_runs_delete BEFORE DELETE ON agent_runtime_runs
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_steps_insert BEFORE INSERT ON agent_runtime_run_steps
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_steps_update BEFORE UPDATE ON agent_runtime_run_steps
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_steps_delete BEFORE DELETE ON agent_runtime_run_steps
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_parts_insert BEFORE INSERT ON agent_runtime_run_parts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_parts_update BEFORE UPDATE ON agent_runtime_run_parts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_run_parts_delete BEFORE DELETE ON agent_runtime_run_parts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_tool_calls_insert BEFORE INSERT ON agent_runtime_tool_calls
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_tool_calls_update BEFORE UPDATE ON agent_runtime_tool_calls
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_tool_calls_delete BEFORE DELETE ON agent_runtime_tool_calls
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_permissions_insert BEFORE INSERT ON agent_runtime_permissions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_permissions_update BEFORE UPDATE ON agent_runtime_permissions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_permissions_delete BEFORE DELETE ON agent_runtime_permissions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_artifacts_insert BEFORE INSERT ON agent_runtime_artifacts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_artifacts_update BEFORE UPDATE ON agent_runtime_artifacts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_artifacts_delete BEFORE DELETE ON agent_runtime_artifacts
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_context_bundles_insert BEFORE INSERT ON agent_runtime_context_bundles
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_context_bundles_update BEFORE UPDATE ON agent_runtime_context_bundles
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_context_bundles_delete BEFORE DELETE ON agent_runtime_context_bundles
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_insert BEFORE INSERT ON agent_runtime_thinking_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_update BEFORE UPDATE ON agent_runtime_thinking_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_delete BEFORE DELETE ON agent_runtime_thinking_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_insert BEFORE INSERT ON agent_runtime_compaction_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_update BEFORE UPDATE ON agent_runtime_compaction_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_delete BEFORE DELETE ON agent_runtime_compaction_summaries
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_interactions_insert BEFORE INSERT ON agent_runtime_interactions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_interactions_update BEFORE UPDATE ON agent_runtime_interactions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_interactions_delete BEFORE DELETE ON agent_runtime_interactions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_work_insert BEFORE INSERT ON agent_runtime_work
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_work_update BEFORE UPDATE ON agent_runtime_work
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_work_delete BEFORE DELETE ON agent_runtime_work
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_insert BEFORE INSERT ON agent_runtime_asset_sessions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_update BEFORE UPDATE ON agent_runtime_asset_sessions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_agent_runtime_asset_sessions_delete BEFORE DELETE ON agent_runtime_asset_sessions
WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

CREATE TRIGGER version_transcript_child BEFORE INSERT ON agent_runtime_sessions WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.parent_session_id) BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
