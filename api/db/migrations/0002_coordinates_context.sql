-- ---------------------------------------------------------------------------
-- 0002_coordinates_context.sql — Coordinates-native context architecture
--
-- Adds append-only event log, first-class ContextBlock/ContextBinding records,
-- frozen run snapshots, context bundles, and a server-side Coordinates snapshot.
-- Existing context_sessions / context_entries / project_memories / context_links
-- remain intact and are mapped into these tables by the service layer.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coordinates_state (
  project_id            TEXT PRIMARY KEY,
  snapshot_json         TEXT NOT NULL,
  revision              INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL,
  updated_by            TEXT
);

CREATE TABLE IF NOT EXISTS context_blocks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK(kind IN (
                  'entry','memory','decision','constraint','risk','artifact',
                  'evidence','bundle','snapshot','correction','review','system'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','archived','superseded')),
  source_type   TEXT,
  source_id     TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT,
  UNIQUE(project_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_context_blocks_project_kind
  ON context_blocks (project_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_blocks_source
  ON context_blocks (source_type, source_id);

CREATE TABLE IF NOT EXISTS context_bindings (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  block_id      TEXT NOT NULL REFERENCES context_blocks(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL
                CHECK(target_kind IN ('node','run','run_event','source_link','block')),
  target_id     TEXT NOT NULL,
  relation      TEXT NOT NULL
                CHECK(relation IN (
                  'uses','references','constrains','resolves','produces',
                  'contains','mentions','discusses','creates','modifies'
                )),
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  UNIQUE(project_id, block_id, target_kind, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_context_bindings_target
  ON context_bindings (project_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_context_bindings_block
  ON context_bindings (block_id);

CREATE TABLE IF NOT EXISTS context_bundles (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  title          TEXT NOT NULL,
  block_ids_json TEXT NOT NULL DEFAULT '[]',
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  created_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_bundles_project
  ON context_bundles (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_run_snapshots (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  bundle_id           TEXT REFERENCES context_bundles(id) ON DELETE SET NULL,
  input_block_ids_json TEXT NOT NULL DEFAULT '[]',
  prompt              TEXT NOT NULL,
  frozen_context_json TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  created_by          TEXT,
  UNIQUE(project_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_context_run_snapshots_node
  ON context_run_snapshots (project_id, node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coord_event_log (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL,
  revision                   INTEGER NOT NULL,
  type                       TEXT NOT NULL,
  node_id                    TEXT,
  run_id                     TEXT,
  context_block_ids_json     TEXT NOT NULL DEFAULT '[]',
  caused_by_event_ids_json   TEXT NOT NULL DEFAULT '[]',
  payload_json               TEXT NOT NULL DEFAULT '{}',
  actor_id                   TEXT,
  created_at                 TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coord_event_project_revision
  ON coord_event_log (project_id, revision);
CREATE INDEX IF NOT EXISTS idx_coord_event_node
  ON coord_event_log (project_id, node_id, revision);
CREATE INDEX IF NOT EXISTS idx_coord_event_run
  ON coord_event_log (project_id, run_id, revision);

UPDATE _meta SET value = '2' WHERE key = 'schema_version';
