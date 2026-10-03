-- AgentSession models `paused` again: a session stopped by the user, or left behind by a
-- forced process exit, stays "paused" so the UI can offer one-click resume.
--
-- No data rewrite is needed. Migration 0032 already canonicalized every historical
-- 'paused'/'blocked' row to 'completed', so no stored row carries a conflicting
-- meaning, and `agent_runtime_sessions.status` is an unconstrained TEXT column
-- (see 0006_agent_runtime.sql). Session-level `interrupted` keeps its separate
-- meaning for non-forced-exit paths.
SELECT 1;
