CREATE TABLE IF NOT EXISTS agent_runtime_assets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL,
  media_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runtime_asset_sessions (
  asset_id TEXT NOT NULL REFERENCES agent_runtime_assets(id) ON DELETE CASCADE,
  -- Sessions use INSERT OR REPLACE; deletion is managed explicitly by the session store.
  session_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_sessions_session ON agent_runtime_asset_sessions(session_id);
ALTER TABLE agent_runtime_messages ADD COLUMN content_parts_json TEXT;
ALTER TABLE agent_runtime_tool_calls ADD COLUMN content_parts_json TEXT;
