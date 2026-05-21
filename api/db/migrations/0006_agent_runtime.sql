-- ---------------------------------------------------------------------------
-- 0006_agent_runtime.sql — Shared harness runtime persistence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_session_id TEXT,
  child_session_ids_json TEXT NOT NULL DEFAULT '[]',
  node_id TEXT,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context_snapshot_id TEXT,
  thinking_mode TEXT NOT NULL,
  permission_rules_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  result_summary TEXT,
  blocked_reason TEXT,
  skill_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_ars_project_updated ON agent_runtime_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ars_project_node ON agent_runtime_sessions(project_id, node_id);
CREATE INDEX IF NOT EXISTS idx_ars_parent ON agent_runtime_sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS agent_runtime_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  tool_call_id TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arm_session_created ON agent_runtime_messages(session_id, sequence, created_at);

CREATE TABLE IF NOT EXISTS agent_runtime_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  visibility TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_are_session_rowid ON agent_runtime_events(session_id);

CREATE TABLE IF NOT EXISTS agent_runtime_tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  category TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  input_ref_json TEXT,
  output_summary TEXT,
  output_ref_json TEXT,
  status TEXT NOT NULL,
  permission_decision_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_artc_session_started ON agent_runtime_tool_calls(session_id, started_at);

CREATE TABLE IF NOT EXISTS agent_runtime_permissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_call_id TEXT,
  coarse_category TEXT NOT NULL,
  internal_gate TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  patterns_json TEXT NOT NULL DEFAULT '[]',
  user_reply TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_arp_session_created ON agent_runtime_permissions(session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runtime_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ara_session_created ON agent_runtime_artifacts(session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runtime_context_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  node_id TEXT,
  profile_id TEXT,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  citations_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arcb_session ON agent_runtime_context_bundles(session_id);

CREATE TABLE IF NOT EXISTS agent_runtime_thinking_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  framing TEXT NOT NULL,
  evidence_used_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_arts_session ON agent_runtime_thinking_summaries(session_id);
