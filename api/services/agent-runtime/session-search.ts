import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";

/** Search persisted history, without loading transcripts or the entire session list. */
export function searchSessions(
  projectId: string,
  query: string,
  limit = 50,
  offset = 0,
) {
  const q = query.trim();
  if (!q) return { items: [], hasMore: false };
  const indexed = Array.from(q).length >= 3;
  const parameter = indexed ? `"${q.replaceAll('"', '""')}"` : q;
  const hit = (table: string) =>
    indexed ? `${table} MATCH ?` : `instr(lower(${table}.text), lower(?)) > 0`;
  const useFtsSnippet = indexed && Array.from(q).length <= 40;
  const excerpt = (table: string) =>
    useFtsSnippet
      ? `snippet(${table}, 0, '', '', '…', 48)`
      : `substr(${table}.text, max(1, instr(lower(${table}.text), lower(?)) - 24), ?)`;
  const sql = `WITH hits AS (
    SELECT s.id, s.updated_at, ${excerpt("agent_search_sessions")} AS snippet, 0 AS priority
    FROM agent_search_sessions JOIN agent_runtime_sessions s ON s.rowid = agent_search_sessions.rowid
    WHERE s.project_id = ? AND s.parent_session_id IS NULL AND ${hit("agent_search_sessions")}
    UNION ALL
    SELECT s.id, s.updated_at, ${excerpt("agent_search_messages")} AS snippet, 1 AS priority
    FROM agent_search_messages
    JOIN agent_runtime_messages m ON m.rowid = agent_search_messages.rowid
    JOIN agent_runtime_sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND s.parent_session_id IS NULL AND ${hit("agent_search_messages")}
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY id ORDER BY priority, snippet) AS position FROM hits
  ) SELECT id, snippet FROM ranked WHERE position = 1 ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`;
  const args = useFtsSnippet
    ? [projectId, parameter]
    : [q, Math.max(160, Array.from(q).length + 72), projectId, parameter];
  const rows = getRawSqlite()
    .prepare(sql)
    .all(...args, ...args, limit + 1, offset) as Array<{
    id: string;
    snippet: string;
  }>;
  return {
    items: rows.slice(0, limit).map((row) => ({
      session: agentRuntimeStore.getSession(row.id),
      snippet: row.snippet,
    })),
    hasMore: rows.length > limit,
  };
}
