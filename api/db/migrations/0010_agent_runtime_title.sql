-- ---------------------------------------------------------------------------
-- 0010_agent_runtime_title.sql — Add title column to sessions (idempotent).
-- ---------------------------------------------------------------------------

-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN.
-- This file is intentionally empty — the column is ensured at runtime via ensureColumn().
