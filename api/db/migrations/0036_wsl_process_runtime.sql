ALTER TABLE agent_runtime_processes ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'host';
ALTER TABLE agent_runtime_processes ADD COLUMN runtime_distribution TEXT;
ALTER TABLE agent_runtime_processes ADD COLUMN runtime_pid INTEGER;
ALTER TABLE agent_runtime_processes ADD COLUMN runtime_pgid INTEGER;
