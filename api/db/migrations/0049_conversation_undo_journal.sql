-- A checkpoint is a pair of cursors, not a copy of the conversation or project.
CREATE TABLE IF NOT EXISTS conversation_history_tracking (
  session_id TEXT PRIMARY KEY,
  last_boundary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_history_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  before_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_journal_session_cursor ON conversation_history_journal(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_history_journal_record ON conversation_history_journal(session_id, table_name, record_key, sequence);
CREATE TABLE IF NOT EXISTS conversation_history_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  suspended INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO conversation_history_control(id,suspended) VALUES (1,0);
ALTER TABLE conversation_mutations ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversation_mutations ADD COLUMN paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversation_mutations ADD COLUMN warning TEXT;

-- Old failures still have real message anchors. Recover the transcript boundary,
-- never fabricate historical file state. Release the old full-history payloads.
UPDATE conversation_checkpoints SET payload_json = json_object(
  'version',2,'boundary',json_object('legacy',json('true'),'cursor',0,
    'sessionIds',json_array(session_id),
    'messageSequence',(SELECT sequence - CASE WHEN conversation_checkpoints.kind='input' THEN 1 ELSE 0 END
      FROM agent_runtime_messages WHERE id=conversation_checkpoints.message_id AND session_id=conversation_checkpoints.session_id),
    'messageCount',(SELECT count(*) FROM agent_runtime_messages m WHERE m.session_id=conversation_checkpoints.session_id
      AND m.sequence <= (SELECT sequence - CASE WHEN conversation_checkpoints.kind='input' THEN 1 ELSE 0 END
        FROM agent_runtime_messages WHERE id=conversation_checkpoints.message_id))))
WHERE json_extract(payload_json,'$.version') = 1;
