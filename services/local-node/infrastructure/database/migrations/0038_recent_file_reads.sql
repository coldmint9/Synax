-- Keep the cross-session context picker history lookup bounded and ordered.
CREATE INDEX IF NOT EXISTS idx_runtime_completed_tool_recency
ON agent_runtime_tool_calls(ended_at DESC)
WHERE status = 'completed';
