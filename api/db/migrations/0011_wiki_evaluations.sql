-- ---------------------------------------------------------------------------
-- 0011_wiki_evaluations.sql
--
-- Wiki Block 评价系统。用户对 block 添加评价标记迭代方向，
-- 评价驱动规划生成，规划完成后通过 Review 闭环。
-- ---------------------------------------------------------------------------

-- ── wiki_evaluations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_evaluations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  block_id        TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  plan_node_id    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_evaluations_project_status
  ON wiki_evaluations(project_id, status);

CREATE INDEX IF NOT EXISTS idx_wiki_evaluations_block
  ON wiki_evaluations(block_id, status);

-- ── wiki_plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_plans (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  snapshot_id             TEXT NOT NULL,
  evaluation_ids_json     TEXT NOT NULL DEFAULT '[]',
  nodes_json              TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'draft',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  confirmed_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_plans_project_status
  ON wiki_plans(project_id, status);

-- ── wiki_plan_nodes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_plan_nodes (
  id                      TEXT PRIMARY KEY,
  plan_id                 TEXT NOT NULL,
  project_id              TEXT NOT NULL,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  evaluation_ids_json     TEXT NOT NULL DEFAULT '[]',
  depends_on_json         TEXT NOT NULL DEFAULT '[]',
  expected_files_json     TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'pending',
  sort_order              INTEGER NOT NULL DEFAULT 0,
  review_result           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  completed_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_plan_nodes_plan
  ON wiki_plan_nodes(plan_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_wiki_plan_nodes_status
  ON wiki_plan_nodes(project_id, status);
