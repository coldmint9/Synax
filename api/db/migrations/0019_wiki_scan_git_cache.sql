CREATE TABLE IF NOT EXISTS wiki_scan_git_cache (
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_commit_sha TEXT NOT NULL,
  working_tree_hash TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, branch, head_commit_sha, working_tree_hash)
);
