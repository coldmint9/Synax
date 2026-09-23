import { getRawSqlite } from "../../../db/index.js";
import { historyError } from "./guards.js";

/** Select identities only. Inactive sessions' potentially large metadata is never
 * materialized merely to discover competing live workspace owners. */
export function* activeWorkspaceSessions(): Generator<string> {
  const db = getRawSqlite(),
    query = db.prepare(
      "SELECT id FROM agent_runtime_sessions s WHERE id>? AND (status IN ('running','queued','stopping','waiting_permission','waiting_input') OR EXISTS(SELECT 1 FROM agent_runtime_processes p WHERE p.session_id=s.id AND p.state<>'closed')) ORDER BY id LIMIT 64",
    );
  let after = "";
  for (;;) {
    const rows = query.all(after) as { id: string }[];
    if (!rows.length) return;
    for (const row of rows) {
      after = row.id;
      yield row.id;
    }
  }
}
export function* openWriterRoots(): Generator<string[]> {
  const db = getRawSqlite(),
    ids = db.prepare(
      "SELECT sequence FROM conversation_mutations WHERE state='open' AND sequence>? ORDER BY sequence LIMIT 64",
    ),
    payload = db.prepare(
      "SELECT CASE WHEN length(CAST(roots_json AS BLOB))<=1048576 THEN roots_json ELSE NULL END AS roots FROM conversation_mutations WHERE sequence=? AND state='open'",
    );
  let after = 0;
  for (;;) {
    const rows = ids.all(after) as { sequence: number }[];
    if (!rows.length) return;
    for (const row of rows) {
      after = row.sequence;
      const value = payload.get(after) as { roots: string | null } | undefined;
      if (!value) continue;
      if (value.roots === null)
        throw historyError(
          "Open writer metadata exceeds the restore lock budget.",
          "HISTORY_PLAN_LIMIT",
        );
      const roots = JSON.parse(value.roots) as unknown;
      if (
        !Array.isArray(roots) ||
        roots.some((root) => typeof root !== "string")
      )
        throw historyError("Invalid open writer workspace metadata.");
      yield roots;
    }
  }
}
