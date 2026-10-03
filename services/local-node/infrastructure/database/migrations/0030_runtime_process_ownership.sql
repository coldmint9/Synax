CREATE TABLE IF NOT EXISTS agent_runtime_processes (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  pid INTEGER,
  process_group INTEGER NOT NULL DEFAULT 1,
  command_label TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_arp_host_state ON agent_runtime_processes(host_id, state);
CREATE INDEX IF NOT EXISTS idx_arp_run ON agent_runtime_processes(run_id);
