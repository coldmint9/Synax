-- Keep user enablement separate from files owned by built-in/local/project sources.
CREATE TABLE IF NOT EXISTS skill_preferences (
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (skill_id, scope)
);
