-- Current execution/audit projections remain mutable only for the explicit
-- Native cohort. Historical reads still come from immutable branch roots.

ALTER TABLE agent_runtime_runs ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_runs_insert;
CREATE TRIGGER version_transcript_agent_runtime_runs_insert BEFORE INSERT ON agent_runtime_runs WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_runs_update;
CREATE TRIGGER version_transcript_agent_runtime_runs_update BEFORE UPDATE ON agent_runtime_runs WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_runs_delete;
CREATE TRIGGER version_transcript_agent_runtime_runs_delete BEFORE DELETE ON agent_runtime_runs WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_run_steps ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_run_steps_insert;
CREATE TRIGGER version_transcript_agent_runtime_run_steps_insert BEFORE INSERT ON agent_runtime_run_steps WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_run_steps_update;
CREATE TRIGGER version_transcript_agent_runtime_run_steps_update BEFORE UPDATE ON agent_runtime_run_steps WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_run_steps_delete;
CREATE TRIGGER version_transcript_agent_runtime_run_steps_delete BEFORE DELETE ON agent_runtime_run_steps WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_run_parts ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_run_parts_insert;
CREATE TRIGGER version_transcript_agent_runtime_run_parts_insert BEFORE INSERT ON agent_runtime_run_parts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_run_parts_update;
CREATE TRIGGER version_transcript_agent_runtime_run_parts_update BEFORE UPDATE ON agent_runtime_run_parts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_run_parts_delete;
CREATE TRIGGER version_transcript_agent_runtime_run_parts_delete BEFORE DELETE ON agent_runtime_run_parts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_tool_calls ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_tool_calls_insert;
CREATE TRIGGER version_transcript_agent_runtime_tool_calls_insert BEFORE INSERT ON agent_runtime_tool_calls WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_tool_calls_update;
CREATE TRIGGER version_transcript_agent_runtime_tool_calls_update BEFORE UPDATE ON agent_runtime_tool_calls WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_tool_calls_delete;
CREATE TRIGGER version_transcript_agent_runtime_tool_calls_delete BEFORE DELETE ON agent_runtime_tool_calls WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_permissions ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_permissions_insert;
CREATE TRIGGER version_transcript_agent_runtime_permissions_insert BEFORE INSERT ON agent_runtime_permissions WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_permissions_update;
CREATE TRIGGER version_transcript_agent_runtime_permissions_update BEFORE UPDATE ON agent_runtime_permissions WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_permissions_delete;
CREATE TRIGGER version_transcript_agent_runtime_permissions_delete BEFORE DELETE ON agent_runtime_permissions WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_artifacts ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_artifacts_insert;
CREATE TRIGGER version_transcript_agent_runtime_artifacts_insert BEFORE INSERT ON agent_runtime_artifacts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_artifacts_update;
CREATE TRIGGER version_transcript_agent_runtime_artifacts_update BEFORE UPDATE ON agent_runtime_artifacts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_artifacts_delete;
CREATE TRIGGER version_transcript_agent_runtime_artifacts_delete BEFORE DELETE ON agent_runtime_artifacts WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_context_bundles ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_context_bundles_insert;
CREATE TRIGGER version_transcript_agent_runtime_context_bundles_insert BEFORE INSERT ON agent_runtime_context_bundles WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_context_bundles_update;
CREATE TRIGGER version_transcript_agent_runtime_context_bundles_update BEFORE UPDATE ON agent_runtime_context_bundles WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_context_bundles_delete;
CREATE TRIGGER version_transcript_agent_runtime_context_bundles_delete BEFORE DELETE ON agent_runtime_context_bundles WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_thinking_summaries ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_thinking_summaries_insert;
CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_insert BEFORE INSERT ON agent_runtime_thinking_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_thinking_summaries_update;
CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_update BEFORE UPDATE ON agent_runtime_thinking_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_thinking_summaries_delete;
CREATE TRIGGER version_transcript_agent_runtime_thinking_summaries_delete BEFORE DELETE ON agent_runtime_thinking_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
ALTER TABLE agent_runtime_compaction_summaries ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_compaction_summaries_insert;
CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_insert BEFORE INSERT ON agent_runtime_compaction_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_compaction_summaries_update;
CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_update BEFORE UPDATE ON agent_runtime_compaction_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_compaction_summaries_delete;
CREATE TRIGGER version_transcript_agent_runtime_compaction_summaries_delete BEFORE DELETE ON agent_runtime_compaction_summaries WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native')
 BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;

ALTER TABLE agent_runtime_work ADD COLUMN version_epoch INTEGER;
DROP TRIGGER version_transcript_agent_runtime_work_insert;
CREATE TRIGGER version_transcript_agent_runtime_work_insert BEFORE INSERT ON agent_runtime_work WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native') BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_work_update;
CREATE TRIGGER version_transcript_agent_runtime_work_update BEFORE UPDATE ON agent_runtime_work WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') OR EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=NEW.session_id AND runtime_mode<>'native') BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
DROP TRIGGER version_transcript_agent_runtime_work_delete;
CREATE TRIGGER version_transcript_agent_runtime_work_delete BEFORE DELETE ON agent_runtime_work WHEN EXISTS(SELECT 1 FROM conversation_v3_heads WHERE session_id=OLD.session_id AND runtime_mode<>'native') BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
