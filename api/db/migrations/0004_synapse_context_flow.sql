-- ---------------------------------------------------------------------------
-- 0004_synapse_context_flow.sql — Synapse Context Flow
--
-- Adds high-value context signals extracted from complete agent loop records
-- and disclosure suggestions that let users approve cross-node handoffs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS context_signals (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  block_id           TEXT NOT NULL REFERENCES context_blocks(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL
                     CHECK(source_type IN ('agent_loop_record','review','manual_note')),
  source_id          TEXT NOT NULL,
  source_node_id     TEXT,
  source_run_id      TEXT,
  kind               TEXT NOT NULL
                     CHECK(kind IN (
                       'decision','risk','constraint','evidence','artifact',
                       'correction','insight'
                     )),
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  content            TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0.7 CHECK(confidence >= 0 AND confidence <= 1),
  tags_json          TEXT NOT NULL DEFAULT '[]',
  source_links_json  TEXT NOT NULL DEFAULT '[]',
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  created_by         TEXT,
  UNIQUE(project_id, source_type, source_id, kind, title)
);

CREATE INDEX IF NOT EXISTS idx_context_signals_project_kind
  ON context_signals (project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_signals_source_node
  ON context_signals (project_id, source_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_signals_block
  ON context_signals (block_id);

CREATE TABLE IF NOT EXISTS context_disclosure_suggestions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  signal_id          TEXT NOT NULL REFERENCES context_signals(id) ON DELETE CASCADE,
  source_node_id     TEXT,
  target_node_id     TEXT NOT NULL,
  relation           TEXT NOT NULL
                     CHECK(relation IN (
                       'uses','references','constrains','resolves','produces',
                       'contains','mentions','discusses','creates','modifies'
                     )),
  confidence         REAL NOT NULL DEFAULT 0.7 CHECK(confidence >= 0 AND confidence <= 1),
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','accepted','dismissed','auto_applied')),
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  decided_by         TEXT,
  decided_at         TEXT,
  UNIQUE(project_id, signal_id, target_node_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_context_disclosure_target
  ON context_disclosure_suggestions (project_id, target_node_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_disclosure_source
  ON context_disclosure_suggestions (project_id, source_node_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_disclosure_signal
  ON context_disclosure_suggestions (signal_id);

UPDATE _meta SET value = '4' WHERE key = 'schema_version';
