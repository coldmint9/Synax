-- AgentSession no longer models blocked/paused. Preserve run/step outcome details,
-- but canonicalize legacy session rows to the single completed terminal state.
UPDATE agent_runtime_sessions
SET status = 'completed',
    completed_at = COALESCE(completed_at, updated_at)
WHERE status IN ('blocked', 'paused');

-- The event was never produced by the current runtime; canonicalize any legacy rows.
UPDATE agent_runtime_events
SET type = 'session_completed'
WHERE type = 'session_blocked';