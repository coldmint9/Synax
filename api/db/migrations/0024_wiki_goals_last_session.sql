-- ---------------------------------------------------------------------------
-- 0024_wiki_goals_last_session.sql — Add last_session_id to wiki_goals (idempotent).
-- ---------------------------------------------------------------------------

-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN.
-- This file is intentionally empty — the column is ensured at runtime via ensureColumn().
