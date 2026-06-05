-- 0018_wiki_fts.sql
-- Full-text search for wiki blocks using FTS5 unicode61 tokenizer.
--
-- search_text is pre-processed in the application layer with CJK character
-- separation (spaces around each CJK character) so unicode61 treats every CJK
-- character as an independent token. English words stay as whole tokens.
-- The search_text column is added by ensureRuntimeSchema in db/index.ts.

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_blocks_fts USING fts5(
  search_text,
  block_id,
  document_id,
  project_id,
  tokenize='unicode61'
);

-- Sync triggers
CREATE TRIGGER IF NOT EXISTS trg_wiki_blocks_fts_ai AFTER INSERT ON wiki_blocks
WHEN new.search_text != '' BEGIN
  INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
  VALUES (new.search_text, new.id, new.document_id, new.project_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_wiki_blocks_fts_ad AFTER DELETE ON wiki_blocks BEGIN
  DELETE FROM wiki_blocks_fts WHERE block_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_wiki_blocks_fts_au AFTER UPDATE OF search_text ON wiki_blocks
WHEN new.search_text != old.search_text BEGIN
  DELETE FROM wiki_blocks_fts WHERE block_id = old.id;
  INSERT INTO wiki_blocks_fts (search_text, block_id, document_id, project_id)
  VALUES (new.search_text, new.id, new.document_id, new.project_id);
END;
