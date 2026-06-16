-- 0023_wiki_goals.sql
-- Issue/Evaluation → Goal refactor: wiki_evaluations → wiki_goals
-- Data migration runs in ensureRuntimeSchema (handles block_id vs document_id, idempotent).

CREATE TABLE IF NOT EXISTS wiki_goals (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'document',
  document_id     TEXT,
  content         TEXT NOT NULL,
  anchor_json     TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  plan_node_id    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_goals_project_status
  ON wiki_goals(project_id, status);

CREATE INDEX IF NOT EXISTS idx_wiki_goals_document
  ON wiki_goals(document_id);

