import { getRawSqlite } from "../../../../db/index.js";
import { AgentRuntimeError } from "../../runtime-errors.js";

export function queueHistoryDeletion(sessionId: string): void {
  const db = getRawSqlite();
  db.transaction(() => {
    const session = db
      .prepare(
        "SELECT status,parent_session_id FROM agent_runtime_sessions WHERE id=?",
      )
      .get(sessionId) as
      | { status: string; parent_session_id: string | null }
      | undefined;
    if (!session) return;
    if (
      session.parent_session_id ||
      db
        .prepare(
          "SELECT 1 FROM agent_runtime_sessions WHERE parent_session_id=? LIMIT 1",
        )
        .get(sessionId)
    )
      throw new AgentRuntimeError(
        "Delete child sessions before deleting this history.",
        "HISTORY_SESSION_BUSY",
        409,
      );
    if (
      [
        "running",
        "queued",
        "stopping",
        "waiting_permission",
        "waiting_input",
      ].includes(session.status) ||
      db
        .prepare(
          "SELECT 1 FROM agent_runtime_runs WHERE session_id=? AND (status IN ('queued','running') OR json_extract(metadata_json,'$.executionLease.closed')=0) LIMIT 1",
        )
        .get(sessionId) ||
      db
        .prepare(
          "SELECT 1 FROM agent_runtime_processes WHERE session_id=? AND state<>'closed' LIMIT 1",
        )
        .get(sessionId)
    )
      throw new AgentRuntimeError(
        "Stop the session before deleting its history.",
        "HISTORY_SESSION_BUSY",
        409,
      );
    db.prepare(
      "INSERT OR IGNORE INTO conversation_v3_deletions(session_id) VALUES(?)",
    ).run(sessionId);
    db.prepare(
      "DELETE FROM conversation_history_tracking WHERE session_id=?",
    ).run(sessionId);
  })();
}

const tables = [
  "agent_runtime_asset_sessions",
  "agent_runtime_stream_records",
  "conversation_history_journal",
  "conversation_checkpoints",
  "conversation_mutations",
  "conversation_history_operations",
  "conversation_history_access",
  "conversation_history_versions",
  "conversation_history_tracking",
  "agent_runtime_interactions",
  "agent_runtime_work",
  "agent_runtime_run_parts",
  "agent_runtime_run_steps",
  "agent_runtime_permissions",
  "agent_runtime_tool_calls",
  "agent_runtime_artifacts",
  "agent_runtime_thinking_summaries",
  "agent_runtime_compaction_summaries",
  "agent_runtime_context_bundles",
  "agent_runtime_events",
  "agent_runtime_messages",
  "agent_runtime_aux_usage",
  "agent_runtime_runs",
];
/** User-visible deletion is one tombstone write. Every physical cleanup step is
 * resumable and limited to 64 identities; it is never a cascade over all history. */
export function collectDeletedHistory(): void {
  const db = getRawSqlite();
  const job = db
    .prepare(
      "SELECT session_id,phase FROM conversation_v3_deletions ORDER BY created_at,session_id LIMIT 1",
    )
    .get() as { session_id: string; phase: number } | undefined;
  if (!job) return;
  const id = job.session_id;
  db.transaction(() => {
    const locators = db
      .prepare(
        "SELECT kind,record_id FROM conversation_v3_runtime_records WHERE session_id=? LIMIT 64",
      )
      .all(id) as { kind: string; record_id: string }[];
    if (locators.length) {
      const remove = db.prepare(
        "DELETE FROM conversation_v3_runtime_records WHERE session_id=? AND kind=? AND record_id=?",
      );
      for (const row of locators) remove.run(id, row.kind, row.record_id);
      return;
    }
    for (const [table, key] of [
      ["conversation_v3_history_requests", "request_id"],
      ["conversation_v3_operations", "request_id"],
      ["conversation_v3_owned_versions", "version_id"],
    ]) {
      const result = db
        .prepare(
          `DELETE FROM ${table} WHERE session_id=? AND ${key} IN (SELECT ${key} FROM ${table} WHERE session_id=? LIMIT 64)`,
        )
        .run(id, id);
      if (result.changes) return;
    }
    db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(id);
    if (job.phase < tables.length) {
      const table = tables[job.phase];
      const result = db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE session_id=? LIMIT 64)`,
        )
        .run(id);
      if (!result.changes)
        db.prepare(
          "UPDATE conversation_v3_deletions SET phase=phase+1 WHERE session_id=?",
        ).run(id);
      return;
    }
    db.prepare(
      "UPDATE agent_runtime_processes SET session_id=NULL WHERE rowid IN (SELECT rowid FROM agent_runtime_processes WHERE session_id=? LIMIT 64)",
    ).run(id);
    if (
      db
        .prepare(
          "SELECT 1 FROM agent_runtime_processes WHERE session_id=? LIMIT 1",
        )
        .get(id)
    )
      return;
    db.prepare("DELETE FROM agent_runtime_sessions WHERE id=?").run(id);
    db.prepare("DELETE FROM conversation_v3_deletions WHERE session_id=?").run(
      id,
    );
  })();
}
