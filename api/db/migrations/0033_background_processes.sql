ALTER TABLE agent_runtime_processes ADD COLUMN kind TEXT NOT NULL DEFAULT 'command';
ALTER TABLE agent_runtime_processes ADD COLUMN exit_code INTEGER;
CREATE INDEX IF NOT EXISTS idx_arp_session_kind ON agent_runtime_processes(session_id, kind, state);
