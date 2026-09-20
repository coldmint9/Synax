-- Trigram indexes support literal substring lookup, including Chinese text.

CREATE VIRTUAL TABLE agent_search_sessions USING fts5(text, tokenize='trigram');
INSERT INTO agent_search_sessions(rowid, text) SELECT rowid, coalesce(agent_runtime_sessions.title, '') || char(10) || agent_runtime_sessions.prompt || char(10) || coalesce(agent_runtime_sessions.result_summary, '') FROM agent_runtime_sessions;
-- INSERT OR REPLACE does not reliably fire delete triggers; remove the old index row first.
CREATE TRIGGER agent_search_sessions_bi BEFORE INSERT ON agent_runtime_sessions BEGIN
  DELETE FROM agent_search_sessions WHERE rowid = (SELECT rowid FROM agent_runtime_sessions WHERE id = new.id);
END;
CREATE TRIGGER agent_search_sessions_ai AFTER INSERT ON agent_runtime_sessions BEGIN
  INSERT INTO agent_search_sessions(rowid, text) VALUES (new.rowid, coalesce(new.title, '') || char(10) || new.prompt || char(10) || coalesce(new.result_summary, ''));
END;
CREATE TRIGGER agent_search_sessions_au AFTER UPDATE OF title, prompt, result_summary ON agent_runtime_sessions BEGIN
  DELETE FROM agent_search_sessions WHERE rowid = old.rowid;
  INSERT INTO agent_search_sessions(rowid, text) VALUES (new.rowid, coalesce(new.title, '') || char(10) || new.prompt || char(10) || coalesce(new.result_summary, ''));
END;
CREATE TRIGGER agent_search_sessions_ad AFTER DELETE ON agent_runtime_sessions BEGIN
  DELETE FROM agent_search_sessions WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE agent_search_messages USING fts5(text, tokenize='trigram');
INSERT INTO agent_search_messages(rowid, text) SELECT rowid, agent_runtime_messages.content FROM agent_runtime_messages;
-- INSERT OR REPLACE does not reliably fire delete triggers; remove the old index row first.
CREATE TRIGGER agent_search_messages_bi BEFORE INSERT ON agent_runtime_messages BEGIN
  DELETE FROM agent_search_messages WHERE rowid = (SELECT rowid FROM agent_runtime_messages WHERE id = new.id);
END;
CREATE TRIGGER agent_search_messages_ai AFTER INSERT ON agent_runtime_messages BEGIN
  INSERT INTO agent_search_messages(rowid, text) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER agent_search_messages_au AFTER UPDATE OF content ON agent_runtime_messages BEGIN
  DELETE FROM agent_search_messages WHERE rowid = old.rowid;
  INSERT INTO agent_search_messages(rowid, text) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER agent_search_messages_ad AFTER DELETE ON agent_runtime_messages BEGIN
  DELETE FROM agent_search_messages WHERE rowid = old.rowid;
END;
