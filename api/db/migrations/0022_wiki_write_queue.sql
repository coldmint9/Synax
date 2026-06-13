-- Persistent queue for wiki Phase 2 document writing (2 concurrent workers).

CREATE TABLE IF NOT EXISTS wiki_write_batches (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_write_batches_snapshot
  ON wiki_write_batches(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_wiki_write_batches_status
  ON wiki_write_batches(status);

CREATE TABLE IF NOT EXISTS wiki_write_queue_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_write_queue_batch_status
  ON wiki_write_queue_items(batch_id, status, sort_order);

CREATE INDEX IF NOT EXISTS idx_wiki_write_queue_snapshot
  ON wiki_write_queue_items(snapshot_id);
