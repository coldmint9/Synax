-- ---------------------------------------------------------------------------
-- 0000_init_context.sql — Synax 内置上下文管理系统初始 DDL
-- 参考 .qoder/specs/context-management-system.md §3.3
--
-- 包含：
--   context_sessions      短期会话
--   context_entries       会话条目（消息轮次）
--   context_snapshots     会话快照（版本控制）
--   project_memories      长期项目记忆
--   context_links         条目↔CoordForest 节点关联
--   context_fts           FTS5 虚拟表（挂接 context_entries）
--   _meta                 模式版本元信息
--
-- 索引策略与规范文档保持一致。所有表均以 project_id 做强制隔离。
-- ---------------------------------------------------------------------------

-- 会话表
CREATE TABLE IF NOT EXISTS context_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','archived','expired')),
  title         TEXT,
  summary       TEXT,
  token_count   INTEGER NOT NULL DEFAULT 0,
  entry_count   INTEGER NOT NULL DEFAULT 0,
  source_agent  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT,
  archived_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_active
  ON context_sessions (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON context_sessions (project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON context_sessions (expires_at) WHERE status = 'active';

-- 条目表
CREATE TABLE IF NOT EXISTS context_entries (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES context_sessions(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  sequence         INTEGER NOT NULL CHECK(sequence >= 0),
  role             TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content          TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'text'
                   CHECK(content_type IN ('text','code','tool_call','tool_result','markdown')),
  token_estimate   INTEGER NOT NULL DEFAULT 0,
  metadata         TEXT NOT NULL DEFAULT '{}',
  parent_entry_id  TEXT REFERENCES context_entries(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_session_seq
  ON context_entries (session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_entries_project_time
  ON context_entries (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_parent
  ON context_entries (parent_entry_id);

-- 快照表
CREATE TABLE IF NOT EXISTS context_snapshots (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES context_sessions(id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL,
  label               TEXT,
  from_sequence       INTEGER NOT NULL,
  to_sequence         INTEGER NOT NULL,
  entry_count         INTEGER NOT NULL,
  compressed_content  TEXT,
  diff_base_id        TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_session
  ON context_snapshots (session_id, created_at DESC);

-- 长期记忆表
CREATE TABLE IF NOT EXISTS project_memories (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  memory_type        TEXT NOT NULL
                     CHECK(memory_type IN ('pattern','decision','preference','convention','insight','risk')),
  title              TEXT NOT NULL,
  content            TEXT NOT NULL,
  source_session_id  TEXT REFERENCES context_sessions(id) ON DELETE SET NULL,
  source_entry_id    TEXT REFERENCES context_entries(id) ON DELETE SET NULL,
  tags               TEXT NOT NULL DEFAULT '[]',
  confidence         REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  access_count       INTEGER NOT NULL DEFAULT 0,
  references_json    TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','archived','superseded')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  expires_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project_type
  ON project_memories (project_id, memory_type, status);
CREATE INDEX IF NOT EXISTS idx_memories_access_evict
  ON project_memories (project_id, access_count);

-- 条目 ↔ CoordForest 节点链接
CREATE TABLE IF NOT EXISTS context_links (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  link_type   TEXT NOT NULL
              CHECK(link_type IN ('mentions','discusses','creates','modifies','references','resolves')),
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  UNIQUE(entry_id, node_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_links_entry
  ON context_links (entry_id);
CREATE INDEX IF NOT EXISTS idx_links_node
  ON context_links (node_id, project_id);

-- 全文搜索虚拟表（挂接 context_entries）
-- external content 模式：FTS 行 rowid 与 context_entries.rowid 对应
-- UNINDEXED 列必须与 content 表同名（project_id/session_id 都存在于 context_entries）。
-- 条目主键 id 通过 rowid JOIN 反查，无需作为 UNINDEXED 列存储。
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  content,
  project_id UNINDEXED,
  session_id UNINDEXED,
  content='context_entries',
  content_rowid='rowid'
);

-- FTS 同步触发器
CREATE TRIGGER IF NOT EXISTS trg_entries_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_fts (rowid, content, project_id, session_id)
  VALUES (new.rowid, new.content, new.project_id, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_fts (context_fts, rowid, content, project_id, session_id)
  VALUES ('delete', old.rowid, old.content, old.project_id, old.session_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_fts (context_fts, rowid, content, project_id, session_id)
  VALUES ('delete', old.rowid, old.content, old.project_id, old.session_id);
  INSERT INTO context_fts (rowid, content, project_id, session_id)
  VALUES (new.rowid, new.content, new.project_id, new.session_id);
END;

-- 元信息表
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');
