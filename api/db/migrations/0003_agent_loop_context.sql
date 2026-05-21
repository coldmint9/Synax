-- ---------------------------------------------------------------------------
-- 0003_agent_loop_context.sql — Loop-level agent context persistence
--
-- Replaces chunk-level run context persistence with complete agent loop
-- records. Streaming chunks still exist as live transport events, but durable
-- context is written once per run/loop with structured steps.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_conversation_turns (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  node_id              TEXT,
  run_id               TEXT NOT NULL,
  user_id              TEXT,
  raw_input            TEXT NOT NULL,
  context_snapshot_id  TEXT,
  status               TEXT NOT NULL DEFAULT 'running'
                       CHECK(status IN ('running','completed','failed','cancelled')),
  metadata_json        TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  completed_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turn_project_run
  ON agent_conversation_turns (project_id, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_turn_node
  ON agent_conversation_turns (project_id, node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_loop_records (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  turn_id              TEXT NOT NULL REFERENCES agent_conversation_turns(id) ON DELETE CASCADE,
  node_id              TEXT,
  run_id               TEXT NOT NULL,
  provider             TEXT NOT NULL,
  status               TEXT NOT NULL
                       CHECK(status IN ('running','completed','failed','cancelled')),
  summary              TEXT,
  final_output         TEXT,
  context_snapshot_id  TEXT,
  transcript_json      TEXT NOT NULL DEFAULT '{}',
  file_changes_json    TEXT NOT NULL DEFAULT '[]',
  metadata_json        TEXT NOT NULL DEFAULT '{}',
  started_at           TEXT NOT NULL,
  completed_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_project_run
  ON agent_loop_records (project_id, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_loop_node
  ON agent_loop_records (project_id, node_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_loop_steps (
  id              TEXT PRIMARY KEY,
  loop_id         TEXT NOT NULL REFERENCES agent_loop_records(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  kind            TEXT NOT NULL
                  CHECK(kind IN (
                    'user_input','context_snapshot','agent_thought','agent_message',
                    'tool_call','tool_result','artifact','final_output','error'
                  )),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_loop_step_sequence
  ON agent_loop_steps (loop_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_loop_step_run
  ON agent_loop_steps (project_id, run_id, sequence);

UPDATE _meta SET value = '3' WHERE key = 'schema_version';
