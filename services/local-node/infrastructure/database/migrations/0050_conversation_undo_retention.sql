CREATE TABLE IF NOT EXISTS conversation_history_access (
  session_id TEXT PRIMARY KEY,
  last_access_at INTEGER NOT NULL,
  expire_through INTEGER NOT NULL DEFAULT 0
);
-- Existing histories receive one day of grace after upgrading. Background work
-- and GET/poll endpoints must never refresh this user-activity timestamp.
INSERT OR IGNORE INTO conversation_history_access(session_id,last_access_at)
SELECT DISTINCT session_id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM conversation_checkpoints;
