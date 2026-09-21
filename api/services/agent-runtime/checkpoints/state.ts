import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { makeRuntimeId, nowIso } from "../runtime-ids.js";

export type Row = Record<string, string | number | null>;
export const HISTORY_TABLES = [
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
export interface HistoryState {
  sessions: Row[];
  tables: Record<string, Row[]>;
}

export function readHistory(
  sessionId: string,
  omitRunId?: string,
): HistoryState {
  return getRawSqlite().transaction(() =>
    readHistoryRows(sessionId, omitRunId),
  )();
}
function readHistoryRows(sessionId: string, omitRunId?: string): HistoryState {
  const db = getRawSqlite();
  const ids = agentRuntimeStore.listSessionTree(sessionId).map((s) => s.id);
  const state: HistoryState = {
    sessions: ids.map(
      (id) =>
        db
          .prepare("SELECT * FROM agent_runtime_sessions WHERE id=?")
          .get(id) as Row,
    ),
    tables: Object.fromEntries(
      HISTORY_TABLES.map((table) => [
        table,
        ids.flatMap(
          (id) =>
            db
              .prepare(
                `SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`,
              )
              .all(id) as Row[],
        ),
      ]),
    ),
  };
  for (const row of [...state.sessions, ...Object.values(state.tables).flat()])
    delete row._metadata;
  if (omitRunId)
    state.tables.agent_runtime_runs = state.tables.agent_runtime_runs.filter(
      (row) => row.id !== omitRunId,
    );
  return state;
}

function insert(table: string, row: Row): void {
  const columns = new Set(
    (
      getRawSqlite().prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
  const keys = Object.keys(row).filter((key) => columns.has(key));
  getRawSqlite()
    .prepare(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    )
    .run(...keys.map((key) => row[key]));
}
function preserveAuthorization(row: Row, current: Row | undefined): Row {
  if (!current) return row;
  const metadata = JSON.parse(String(row.session_metadata_json ?? "{}")) ?? {};
  const latest =
    JSON.parse(String(current.session_metadata_json ?? "{}")) ?? {};
  for (const key of ["permissionTier", "permissionOverrides"]) {
    delete metadata[key];
    if (latest[key] !== undefined) metadata[key] = latest[key];
  }
  return {
    ...row,
    permission_rules_json: current.permission_rules_json,
    session_metadata_json: JSON.stringify(metadata),
  };
}
function closeHistoricalAction(table: string, row: Row): Row {
  if (table === "agent_runtime_runs") {
    const metadata = JSON.parse(String(row.metadata_json ?? "{}"));
    delete metadata.executionLease;
    delete metadata.recovery;
    return { ...row, metadata_json: JSON.stringify(metadata) };
  }
  if (
    table === "agent_runtime_run_steps" &&
    ["running", "waiting_permission", "waiting_input"].includes(
      String(row.status),
    )
  )
    return {
      ...row,
      status: "interrupted",
      completed_at: nowIso(),
      finish_reason: "history_restored",
    };
  if (
    table === "agent_runtime_tool_calls" &&
    ["pending", "running"].includes(String(row.status))
  )
    return {
      ...row,
      status: "failed",
      ended_at: nowIso(),
      error: "Execution was not carried across the history boundary.",
    };
  if (table === "agent_runtime_permissions" && !row.resolved_at)
    return {
      ...row,
      action: "deny",
      user_reply: "reject",
      resolved_at: nowIso(),
      resume_token: null,
    };
  return row;
}
function cleanMetadata(row: Row): Row {
  const metadata = JSON.parse(String(row.session_metadata_json ?? "{}")) ?? {};
  for (const key of [
    "runtimeControl",
    "manualStop",
    "inputQueue",
    "inputForceInjectId",
    "pendingResume",
    "turnReferences",
  ])
    delete metadata[key];
  // No pending permission/continuation from the old future may survive a restore.
  return {
    ...row,
    session_metadata_json: JSON.stringify(metadata),
    status: "completed",
    active_run_id: null,
    pending_resume_token: null,
    blocked_reason: null,
    updated_at: nowIso(),
  };
}
export function replaceHistory(
  sessionId: string,
  snapshot: HistoryState,
): void {
  const db = getRawSqlite();
  const currentIds = agentRuntimeStore
    .listSessionTree(sessionId)
    .map((s) => s.id);
  const currentRows = new Map(
    currentIds.map((id) => [
      id,
      db
        .prepare("SELECT * FROM agent_runtime_sessions WHERE id=?")
        .get(id) as Row,
    ]),
  );
  const retained = new Set(snapshot.sessions.map((row) => row.id));
  for (const id of currentIds) {
    for (const table of HISTORY_TABLES)
      db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
    db.prepare(
      "DELETE FROM agent_runtime_stream_records WHERE session_id=?",
    ).run(id);
    if (!retained.has(id)) {
      db.prepare(
        "UPDATE agent_runtime_processes SET session_id=NULL WHERE session_id=?",
      ).run(id);
      db.prepare("DELETE FROM agent_runtime_sessions WHERE id=?").run(id);
      db.prepare("DELETE FROM conversation_checkpoints WHERE session_id=?").run(
        id,
      );
    }
  }
  for (const row of snapshot.sessions) {
    db.prepare("DELETE FROM agent_runtime_sessions WHERE id=?").run(row.id);
    insert(
      "agent_runtime_sessions",
      cleanMetadata(
        preserveAuthorization(row, currentRows.get(String(row.id))),
      ),
    );
  }
  for (const table of HISTORY_TABLES)
    for (const original of snapshot.tables[table] ?? []) {
      let row = closeHistoricalAction(table, { ...original });
      if (
        table === "agent_runtime_runs" &&
        ["running", "queued", "waiting_permission", "waiting_input"].includes(
          String(row.status),
        )
      )
        row = {
          ...row,
          status: "interrupted",
          completed_at: nowIso(),
          stop_reason: "history_restored",
        };
      if (table === "agent_runtime_interactions" && row.status === "pending")
        row = { ...row, status: "cancelled", resolved_at: nowIso() };
      insert(table, row);
    }
}

export function cloneHistory(
  snapshot: HistoryState,
  sourceId: string,
  checkpointId: string,
  roots: Map<string, string>,
): { id: string; state: HistoryState } {
  const ids = new Map<string, string>();
  for (const row of [
    ...snapshot.sessions,
    ...Object.entries(snapshot.tables)
      .filter(([table]) => table !== "agent_runtime_asset_sessions")
      .flatMap(([, rows]) => rows),
  ])
    if (typeof row.id === "string") ids.set(row.id, makeRuntimeId("fork"));
  const id = ids.get(sourceId)!;
  const rewrite = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/(?:id|ids)$/i.test(key) && ids.has(value)) return ids.get(value);
      if (
        ["path", "workDir", "root", "workspacePath"].includes(key) &&
        roots.has(value)
      )
        return roots.get(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]),
      );
    return value;
  };
  const transform = (row: Row): Row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key.endsWith("_json") && typeof value === "string"
          ? JSON.stringify(
              rewrite(JSON.parse(value), key.replace(/_json$/, "")),
            )
          : rewrite(value, key),
      ]),
    ) as Row;
  const state: HistoryState = {
    sessions: snapshot.sessions.map((row) => cleanMetadata(transform(row))),
    tables: Object.fromEntries(
      Object.entries(snapshot.tables).map(([table, rows]) => [
        table,
        rows.map(transform),
      ]),
    ),
  };
  const index = state.sessions.findIndex((row) => row.id === id);
  state.sessions[index] = preserveAuthorization(
    state.sessions[index],
    getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_sessions WHERE id=?")
      .get(sourceId) as Row,
  );
  const root = state.sessions[index];
  const metadata = JSON.parse(String(root.session_metadata_json));
  delete metadata.gitWorkspace;
  metadata.forkedFromSessionId = sourceId;
  metadata.forkedFromCheckpointId = checkpointId;
  root.session_metadata_json = JSON.stringify(metadata);
  root.parent_session_id = null;
  root.created_at = nowIso();
  root.title = `${root.title || "Conversation"} · fork`;
  // Insert root first so replaceHistory can enumerate its tree.
  return { id, state };
}
export function insertForkState(state: HistoryState): void {
  for (const row of state.sessions) insert("agent_runtime_sessions", row);
  for (const table of HISTORY_TABLES)
    for (const original of state.tables[table] ?? []) {
      let row = closeHistoricalAction(table, original);
      if (
        table === "agent_runtime_runs" &&
        ["running", "queued", "waiting_input", "waiting_permission"].includes(
          String(row.status),
        )
      )
        row = {
          ...row,
          status: "interrupted",
          stop_reason: "forked",
          completed_at: nowIso(),
        };
      if (table === "agent_runtime_interactions" && row.status === "pending")
        row = { ...row, status: "cancelled", resolved_at: nowIso() };
      insert(table, row);
    }
}
