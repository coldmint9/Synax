import { getRawSqlite } from "../../../db/index.js";

/** Test-owned teardown only. Production deletion needs its own resumable policy. */
export function clearVersionSessionFixture(sessionId: string): void {
  const db = getRawSqlite();
  db.transaction(() => {
    db.prepare("DELETE FROM conversation_v3_runtime_records WHERE session_id=?").run(sessionId);
    db.prepare("DELETE FROM conversation_v3_deletions WHERE session_id=?").run(sessionId);
    db.prepare(
      "DELETE FROM conversation_v3_history_requests WHERE session_id=?",
    ).run(sessionId);
    db.prepare("DELETE FROM conversation_v3_operations WHERE session_id=?").run(
      sessionId,
    );
    db.prepare(
      "DELETE FROM conversation_v3_owned_versions WHERE session_id=?",
    ).run(sessionId);
    db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(
      sessionId,
    );
  })();
}
