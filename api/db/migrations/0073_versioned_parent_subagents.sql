-- A subagent under a versioned root is supported again: the child is an ordinary
-- legacy (non-versioned) session, so the parent's version reader and rollback path
-- never depend on the child's transcript, runs or events.
--
-- The old guard rejected every child of a versioned session outright. The invariant
-- it protected still holds, so it is replaced rather than simply dropped: versioned
-- history remains root-only, and a head must never be attached to a session that has
-- a parent. `initializeFreshVersionNative` and `initializeVersionTranscript` enforce
-- the same rule in code (bridge.ts); this trigger keeps it against unported writers.
DROP TRIGGER IF EXISTS version_transcript_child;

CREATE TRIGGER version_transcript_root_head BEFORE INSERT ON conversation_v3_heads
WHEN EXISTS(SELECT 1 FROM agent_runtime_sessions WHERE id=NEW.session_id AND parent_session_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'VERSION_RUNTIME_NOT_READY'); END;
