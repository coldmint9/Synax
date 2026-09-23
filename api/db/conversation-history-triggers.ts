import type NativeDatabase from "libsql";

/** Keep the live runtime tables as the current stack projection. Only changed rows
 * need an old version; inserting a message does not duplicate its content. */
export const CONVERSATION_HISTORY_TABLES = [
  "agent_runtime_sessions",
  "agent_runtime_messages",
  "agent_runtime_runs",
  "agent_runtime_run_steps",
  "agent_runtime_run_parts",
  "agent_runtime_tool_calls",
  "agent_runtime_permissions",
  "agent_runtime_artifacts",
  "agent_runtime_context_bundles",
  "agent_runtime_thinking_summaries",
  "agent_runtime_compaction_summaries",
  "agent_runtime_interactions",
  "agent_runtime_work",
  "agent_runtime_events",
  "agent_runtime_asset_sessions",
] as const;

export function installConversationHistoryTriggers(
  db: NativeDatabase.Database,
): void {
  const enabled =
    "(SELECT suspended FROM conversation_history_control WHERE id=1)=0";
  for (const table of CONVERSATION_HISTORY_TABLES) {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
    const compound = table === "agent_runtime_asset_sessions";
    const key = (alias: string) =>
      compound
        ? `json_array(${alias}.asset_id,${alias}.session_id)`
        : `${alias}.id`;
    const session = (alias: string) =>
      `${alias}.${table === "agent_runtime_sessions" ? "id" : "session_id"}`;
    // A stopped source may not change while its current state is copied across
    // short transactions. Enforced in SQLite, including writes from other APIs.
    for (const [operation, alias] of [["INSERT", "NEW"], ["UPDATE", "OLD"], ["DELETE", "OLD"]]) {
      const trigger = `conversation_migration_${table}_${operation.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.exec(`CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table}
        WHEN EXISTS(SELECT 1 FROM conversation_v3_migrations WHERE session_id=${session(alias)} AND state='copying')
        BEGIN SELECT RAISE(ABORT,'HISTORY_MIGRATION_BUSY'); END;`);
      if (operation !== "DELETE") {
        const deleting = `conversation_deleting_${table}_${operation.toLowerCase()}`;
        db.exec(`DROP TRIGGER IF EXISTS ${deleting}`);
        db.exec(`CREATE TRIGGER ${deleting} BEFORE ${operation} ON ${table}
          WHEN EXISTS(SELECT 1 FROM conversation_v3_deletions WHERE session_id=${session(alias)})
          BEGIN SELECT RAISE(ABORT,'HISTORY_SESSION_DELETED'); END;`);
      }
    }
    const match = (a: string, b: string) =>
      compound
        ? `${a}.asset_id=${b}.asset_id AND ${a}.session_id=${b}.session_id`
        : `${a}.id=${b}.id`;
    const json = (alias: string) =>
      `json_object(${columns.flatMap((c) => [`'${c}'`, `${alias}."${c}"`]).join(",")})`;
    const tracked = (alias: string) =>
      `EXISTS(SELECT 1 FROM conversation_history_tracking WHERE session_id=${session(alias)})`;
    const firstChange = (alias: string) =>
      `NOT EXISTS(SELECT 1 FROM conversation_history_journal j WHERE j.session_id=${session(alias)} AND j.table_name='${table}' AND j.record_key=${key(alias)} AND j.sequence>(SELECT last_boundary FROM conversation_history_tracking WHERE session_id=${session(alias)}))`;
    // Reinstall after compatibility columns are repaired, so fresh/legacy databases
    // and future additive columns have the same trigger shape.
    for (const suffix of ["insert", "update", "delete"])
      db.exec(`DROP TRIGGER IF EXISTS conversation_undo_${table}_${suffix}`);
    const childTracking =
      table === "agent_runtime_sessions"
        ? `INSERT OR IGNORE INTO conversation_history_tracking(session_id) SELECT NEW.id WHERE EXISTS(SELECT 1 FROM conversation_history_tracking WHERE session_id=NEW.parent_session_id);`
        : "";
    db.exec(`CREATE TRIGGER conversation_undo_${table}_insert BEFORE INSERT ON ${table}
      WHEN ${enabled} BEGIN
        ${childTracking}
        INSERT INTO conversation_history_journal(session_id,table_name,record_key,before_json)
        SELECT ${session("NEW")},'${table}',${key("NEW")},(SELECT ${json("prior")} FROM ${table} prior WHERE ${match("prior", "NEW")})
        WHERE ${tracked("NEW")} AND ${firstChange("NEW")} AND NOT EXISTS(SELECT 1 FROM ${table} prior WHERE ${match("prior", "NEW")} AND ${json("prior")}=${json("NEW")});
      END;`);
    db.exec(`CREATE TRIGGER conversation_undo_${table}_update BEFORE UPDATE ON ${table}
      WHEN ${enabled} AND ${tracked("OLD")} AND ${firstChange("OLD")} AND ${json("OLD")} IS NOT ${json("NEW")}
      BEGIN INSERT INTO conversation_history_journal(session_id,table_name,record_key,before_json)
        VALUES (${session("OLD")},'${table}',${key("OLD")},${json("OLD")}); END;`);
    db.exec(`CREATE TRIGGER conversation_undo_${table}_delete BEFORE DELETE ON ${table}
      WHEN ${enabled} AND ${tracked("OLD")} AND ${firstChange("OLD")}
      BEGIN INSERT INTO conversation_history_journal(session_id,table_name,record_key,before_json)
        VALUES (${session("OLD")},'${table}',${key("OLD")},${json("OLD")}); END;`);
  }
}
