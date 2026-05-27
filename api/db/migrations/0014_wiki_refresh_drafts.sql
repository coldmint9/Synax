-- 0014_wiki_refresh_drafts.sql
-- Replace per-block patches with document-level refresh drafts

CREATE TABLE IF NOT EXISTS wiki_refresh_drafts (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  snapshot_id           TEXT NOT NULL,
  refresh_task_id       TEXT,
  document_id           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'generating',
  changes_json          TEXT NOT NULL DEFAULT '[]',
  summary               TEXT,
  source_commit_sha     TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT,
  decided_at            TEXT,
  decided_by            TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_drafts_project_status
  ON wiki_refresh_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_refresh_drafts_document
  ON wiki_refresh_drafts(document_id);
CREATE INDEX IF NOT EXISTS idx_refresh_drafts_task
  ON wiki_refresh_drafts(refresh_task_id);

-- Extend wiki_refresh_tasks with draft tracking columns
-- (handled by ensureColumn in db/index.ts for idempotency)

-- Extend wiki_block_revisions to support draft source
-- (handled by ensureColumn in db/index.ts for idempotency)
