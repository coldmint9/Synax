-- Wiki Scan Cache: stores last successful scan per project for incremental diff
CREATE TABLE IF NOT EXISTS wiki_scan_cache (
  project_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  code_index_json TEXT NOT NULL,
  communities_json TEXT,
  updated_at TEXT NOT NULL
);
