-- Add wiki_jobs table for L2 admission queue (idempotent)
CREATE TABLE IF NOT EXISTS wiki_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  snapshot_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  work_dir TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_jobs_status ON wiki_jobs(status);
CREATE INDEX IF NOT EXISTS idx_wiki_jobs_project ON wiki_jobs(project_id);
