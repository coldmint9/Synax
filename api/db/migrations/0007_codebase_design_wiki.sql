-- ---------------------------------------------------------------------------
-- 0007_codebase_design_wiki.sql
--
-- Codebase Design Wiki 专用存储模型。
-- Markdown 只是导出格式，结构化表是事实源。
-- ---------------------------------------------------------------------------

-- ── wiki_snapshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_snapshots (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  branch              TEXT NOT NULL,
  head_commit_sha     TEXT NOT NULL,
  working_tree_hash   TEXT NOT NULL,
  repo_index_id       TEXT,
  revision            INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'ready',
  document_ids_json   TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_wiki_snapshots_project_revision
  ON wiki_snapshots(project_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_snapshots_project_git
  ON wiki_snapshots(project_id, branch, head_commit_sha, working_tree_hash);

-- ── wiki_documents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_documents (
  id            TEXT PRIMARY KEY,
  snapshot_id   TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  doc_type      TEXT NOT NULL,
  parent_id     TEXT,
  block_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_documents_snapshot
  ON wiki_documents(snapshot_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_wiki_documents_project_type
  ON wiki_documents(project_id, doc_type);

-- ── wiki_blocks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_blocks (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  document_id             TEXT NOT NULL,
  block_type              TEXT NOT NULL,
  content_json            TEXT NOT NULL DEFAULT '{}',
  content_format          TEXT NOT NULL DEFAULT 'markdown_fragment',
  source_binding_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash            TEXT NOT NULL DEFAULT '',
  generated_from_hash     TEXT,
  stale_state             TEXT NOT NULL DEFAULT 'fresh',
  manual_state            TEXT NOT NULL DEFAULT 'none',
  confidence              REAL NOT NULL DEFAULT 0.5,
  generated_by_json       TEXT NOT NULL DEFAULT '{}',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_blocks_document
  ON wiki_blocks(document_id);

CREATE INDEX IF NOT EXISTS idx_wiki_blocks_project_stale
  ON wiki_blocks(project_id, stale_state);

CREATE INDEX IF NOT EXISTS idx_wiki_blocks_project_manual
  ON wiki_blocks(project_id, manual_state);

-- ── wiki_block_revisions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_block_revisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  block_id      TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  content_json  TEXT NOT NULL DEFAULT '{}',
  content_hash  TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'agent',
  patch_id      TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_block_revisions_block
  ON wiki_block_revisions(block_id, revision DESC);

-- ── wiki_source_bindings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_source_bindings (
  id                          TEXT PRIMARY KEY,
  project_id                  TEXT NOT NULL,
  wiki_block_id               TEXT NOT NULL,
  source_type                 TEXT NOT NULL,
  source_id                   TEXT NOT NULL,
  last_verified_repo_index_id TEXT,
  last_verified_hash          TEXT,
  precision                   TEXT NOT NULL DEFAULT 'file',
  confidence                  REAL NOT NULL DEFAULT 0.5,
  created_by                  TEXT NOT NULL DEFAULT 'agent',
  created_at                  TEXT NOT NULL,
  -- Persisted locator (no scan needed for resolve)
  file_path                   TEXT,
  start_line                  INTEGER,
  end_line                    INTEGER,
  qualified_name              TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_source_bindings_block
  ON wiki_source_bindings(wiki_block_id);

CREATE INDEX IF NOT EXISTS idx_wiki_source_bindings_source
  ON wiki_source_bindings(project_id, source_id);

-- ── wiki_source_block_index ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_source_block_index (
  project_id          TEXT NOT NULL,
  repo_index_id       TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  wiki_block_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at          TEXT NOT NULL,
  PRIMARY KEY(project_id, repo_index_id, source_id)
);

-- ── wiki_patches ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_patches (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  snapshot_id           TEXT NOT NULL,
  refresh_task_id       TEXT,
  agent_session_id      TEXT,
  target_document_id    TEXT NOT NULL,
  target_block_ids_json TEXT NOT NULL DEFAULT '[]',
  kind                  TEXT NOT NULL DEFAULT 'update',
  status                TEXT NOT NULL DEFAULT 'pending',
  risk                  TEXT NOT NULL DEFAULT 'medium',
  confidence            REAL NOT NULL DEFAULT 0.5,
  old_content_json      TEXT,
  new_content_json      TEXT NOT NULL DEFAULT '{}',
  source_diff_ids_json  TEXT NOT NULL DEFAULT '[]',
  reasoning_json        TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  decided_by            TEXT,
  decided_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_patches_project_status
  ON wiki_patches(project_id, status);

CREATE INDEX IF NOT EXISTS idx_wiki_patches_snapshot
  ON wiki_patches(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_wiki_patches_task
  ON wiki_patches(refresh_task_id);

-- ── wiki_refresh_tasks ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_refresh_tasks (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  snapshot_id             TEXT NOT NULL,
  base_repo_index_id      TEXT,
  next_repo_index_id      TEXT,
  status                  TEXT NOT NULL DEFAULT 'queued',
  priority                TEXT NOT NULL DEFAULT 'p1',
  affected_block_ids_json TEXT NOT NULL DEFAULT '[]',
  patch_ids_json          TEXT NOT NULL DEFAULT '[]',
  error_message           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  completed_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_refresh_tasks_project
  ON wiki_refresh_tasks(project_id, status);

-- ── wiki_design_mapping_tasks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_design_mapping_tasks (
  id                          TEXT PRIMARY KEY,
  project_id                  TEXT NOT NULL,
  source_snapshot_id          TEXT NOT NULL,
  selected_block_ids_json     TEXT NOT NULL DEFAULT '[]',
  selected_text               TEXT NOT NULL DEFAULT '',
  user_instruction            TEXT NOT NULL DEFAULT '',
  related_coordinate_ids_json TEXT NOT NULL DEFAULT '[]',
  generated_goal_id           TEXT,
  generated_action_ids_json   TEXT NOT NULL DEFAULT '[]',
  action_context_bundle_id    TEXT NOT NULL,
  acp_session_id              TEXT,
  status                      TEXT NOT NULL DEFAULT 'draft',
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_dmt_project_status
  ON wiki_design_mapping_tasks(project_id, status);

CREATE INDEX IF NOT EXISTS idx_wiki_dmt_snapshot
  ON wiki_design_mapping_tasks(source_snapshot_id);

-- ── wiki_action_context_bundles ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_action_context_bundles (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  selected_text           TEXT NOT NULL DEFAULT '',
  user_instruction        TEXT NOT NULL DEFAULT '',
  wiki_block_ids_json     TEXT NOT NULL DEFAULT '[]',
  coordinate_ids_json     TEXT NOT NULL DEFAULT '[]',
  file_ids_json           TEXT NOT NULL DEFAULT '[]',
  symbol_ids_json         TEXT NOT NULL DEFAULT '[]',
  constraints_json        TEXT NOT NULL DEFAULT '[]',
  related_test_files_json TEXT NOT NULL DEFAULT '[]',
  created_at              TEXT NOT NULL
);
