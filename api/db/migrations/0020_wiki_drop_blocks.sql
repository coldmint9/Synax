-- 0020_wiki_drop_blocks.sql
-- Clean break: remove block model; documents store markdown + structured references.

-- Drop block FTS
DROP TRIGGER IF EXISTS trg_wiki_blocks_fts_ai;
DROP TRIGGER IF EXISTS trg_wiki_blocks_fts_ad;
DROP TRIGGER IF EXISTS trg_wiki_blocks_fts_au;
DROP TABLE IF EXISTS wiki_blocks_fts;

-- Drop block-related tables
DROP TABLE IF EXISTS wiki_block_revisions;
DROP TABLE IF EXISTS wiki_source_bindings;
DROP TABLE IF EXISTS wiki_source_block_index;
DROP TABLE IF EXISTS wiki_patches;
DROP TABLE IF EXISTS wiki_design_mapping_tasks;
DROP TABLE IF EXISTS wiki_action_context_bundles;
DROP TABLE IF EXISTS wiki_blocks;

-- Clear wiki data (clean break)
DELETE FROM wiki_refresh_drafts;
DELETE FROM wiki_refresh_tasks;
DELETE FROM wiki_evaluations;
DELETE FROM wiki_plan_nodes;
DELETE FROM wiki_plans;
DELETE FROM wiki_documents;
DELETE FROM wiki_snapshots;

-- Recreate wiki_documents with markdown body
DROP TABLE IF EXISTS wiki_documents;
CREATE TABLE wiki_documents (
  id                TEXT PRIMARY KEY,
  snapshot_id       TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  title             TEXT NOT NULL,
  doc_type          TEXT NOT NULL,
  parent_id         TEXT,
  content_md        TEXT NOT NULL DEFAULT '',
  references_json   TEXT NOT NULL DEFAULT '[]',
  search_text       TEXT NOT NULL DEFAULT '',
  pipeline_stage    TEXT NOT NULL DEFAULT 'pending',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  manual_state      TEXT NOT NULL DEFAULT 'none',
  stale_state       TEXT NOT NULL DEFAULT 'fresh',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_documents_snapshot
  ON wiki_documents(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_wiki_documents_project_stale
  ON wiki_documents(project_id, stale_state);

-- Recreate evaluations anchored to documents
DROP TABLE IF EXISTS wiki_evaluations;
CREATE TABLE wiki_evaluations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  document_id     TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  plan_node_id    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_evaluations_project_status
  ON wiki_evaluations(project_id, status);

CREATE INDEX IF NOT EXISTS idx_wiki_evaluations_document
  ON wiki_evaluations(document_id, status);

-- Document-level FTS
DROP TABLE IF EXISTS wiki_documents_fts;
CREATE VIRTUAL TABLE wiki_documents_fts USING fts5(
  search_text,
  document_id,
  project_id,
  tokenize='unicode61'
);

CREATE TRIGGER trg_wiki_documents_fts_ai AFTER INSERT ON wiki_documents
WHEN new.search_text != '' BEGIN
  INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
  VALUES (new.search_text, new.id, new.project_id);
END;

CREATE TRIGGER trg_wiki_documents_fts_ad AFTER DELETE ON wiki_documents BEGIN
  DELETE FROM wiki_documents_fts WHERE document_id = old.id;
END;

CREATE TRIGGER trg_wiki_documents_fts_au AFTER UPDATE OF search_text ON wiki_documents
WHEN new.search_text != old.search_text BEGIN
  DELETE FROM wiki_documents_fts WHERE document_id = old.id;
  INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
  VALUES (new.search_text, new.id, new.project_id);
END;
