-- Wiki Plan Node Artifacts
CREATE TABLE IF NOT EXISTS wiki_plan_node_artifacts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  session_id TEXT,
  patches_json TEXT NOT NULL DEFAULT '[]',
  execution_log TEXT,
  commit_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  redo_count INTEGER NOT NULL DEFAULT 0,
  redo_feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_node_artifacts_node_id ON wiki_plan_node_artifacts(node_id);
CREATE INDEX IF NOT EXISTS idx_plan_node_artifacts_plan_id ON wiki_plan_node_artifacts(plan_id);
