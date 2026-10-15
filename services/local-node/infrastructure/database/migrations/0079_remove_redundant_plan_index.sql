-- The UNIQUE(session_id, revision) constraint already provides the same
-- lookup order as this non-unique index. Keeping both made every plan write
-- maintain two identical B-trees.
DROP INDEX IF EXISTS idx_agent_plan_artifacts_session_revision;
