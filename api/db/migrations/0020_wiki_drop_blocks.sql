-- 0020_wiki_drop_blocks.sql
-- Idempotent cleanup of legacy block model tables.
-- Safe to re-run on every startup — must NOT delete wiki snapshots/documents.
-- Document markdown columns are added via ensureRuntimeSchema in db/index.ts.

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

-- Document-level FTS (idempotent)
DROP TABLE IF EXISTS wiki_documents_fts;
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_documents_fts USING fts5(
  search_text,
  document_id,
  project_id,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_wiki_documents_fts_ai AFTER INSERT ON wiki_documents
WHEN new.search_text != '' BEGIN
  INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
  VALUES (new.search_text, new.id, new.project_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_wiki_documents_fts_ad AFTER DELETE ON wiki_documents BEGIN
  DELETE FROM wiki_documents_fts WHERE document_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_wiki_documents_fts_au AFTER UPDATE OF search_text ON wiki_documents
WHEN new.search_text != old.search_text BEGIN
  DELETE FROM wiki_documents_fts WHERE document_id = old.id;
  INSERT INTO wiki_documents_fts (search_text, document_id, project_id)
  VALUES (new.search_text, new.id, new.project_id);
END;
