CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY REFERENCES agent_runtime_processes(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  owner_session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  command TEXT,
  cols INTEGER NOT NULL DEFAULT 100,
  rows INTEGER NOT NULL DEFAULT 30,
  output_tail TEXT NOT NULL DEFAULT '',
  output_sequence INTEGER NOT NULL DEFAULT 0,
  request_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_terminal_project ON terminal_sessions(project_id, kind);
