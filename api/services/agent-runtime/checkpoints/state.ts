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
    upsertRecord(
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

/** Constant-sized per-session boundary; no messages, file lists or content copies. */
export interface HistoryBoundary {
  cursor: number;
  sessionIds: string[];
  messageCount: number;
  omitRunId?: string;
  legacy?: boolean;
  messageSequence?: number | null;
}
export function withoutHistoryJournal<T>(action: () => T): T {
  const db = getRawSqlite();
  return db.transaction(() => {
    const previous = (
      db
        .prepare(
          "SELECT suspended FROM conversation_history_control WHERE id=1",
        )
        .get() as { suspended: number }
    ).suspended;
    db.prepare(
      "UPDATE conversation_history_control SET suspended=1 WHERE id=1",
    ).run();
    try {
      return action();
    } finally {
      db.prepare(
        "UPDATE conversation_history_control SET suspended=? WHERE id=1",
      ).run(previous);
    }
  })();
}
export function captureHistoryBoundary(
  sessionId: string,
  omitRunId?: string,
): HistoryBoundary {
  const db = getRawSqlite();
  return db.transaction(() => {
    const sessionIds = agentRuntimeStore
      .listSessionTree(sessionId)
      .map((s) => s.id);
    for (const id of sessionIds)
      db.prepare(
        "INSERT OR IGNORE INTO conversation_history_tracking(session_id) VALUES (?)",
      ).run(id);
    const cursor = (
      db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_history_journal",
        )
        .get() as { cursor: number }
    ).cursor;
    const messageCount = (
      db
        .prepare(
          "SELECT count(*) AS count FROM agent_runtime_messages WHERE session_id=?",
        )
        .get(sessionId) as { count: number }
    ).count;
    for (const id of sessionIds)
      db.prepare(
        "UPDATE conversation_history_tracking SET last_boundary=? WHERE session_id=?",
      ).run(cursor, id);
    return {
      cursor,
      sessionIds,
      messageCount,
      ...(omitRunId ? { omitRunId } : {}),
    };
  })();
}
interface HistoryUndo {
  table_name: string;
  record_key: string;
  before_json: string | null;
  sequence: number;
}
const recordKey = (table: string, row: Row) =>
  table === "agent_runtime_asset_sessions"
    ? JSON.stringify([row.asset_id, row.session_id])
    : String(row.id);
function deleteRecord(table: string, key: string): void {
  const db = getRawSqlite();
  if (table === "agent_runtime_asset_sessions")
    db.prepare(`DELETE FROM ${table} WHERE asset_id=? AND session_id=?`).run(
      ...JSON.parse(key),
    );
  else db.prepare(`DELETE FROM ${table} WHERE id=?`).run(key);
}
function upsertRecord(table: string, row: Row): void {
  const columns = (
    getRawSqlite().prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  const keys = columns.filter((k) => k in row);
  const primary =
    table === "agent_runtime_asset_sessions"
      ? ["asset_id", "session_id"]
      : ["id"];
  const updates = keys
    .filter((k) => !primary.includes(k))
    .map((k) => `"${k}"=excluded."${k}"`)
    .join(",");
  getRawSqlite()
    .prepare(
      `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(${primary.join(",")}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`,
    )
    .run(...keys.map((k) => row[k]));
}
function eachUndo(
  sessionIds: string[],
  cursor: number,
  visit: (row: HistoryUndo) => void,
): void {
  const db = getRawSqlite();
  // The TEMP view carries only journal identities. Read one old row version at a
  // time, not a second copy of the entire conversation in JS memory.
  const placeholders = sessionIds.map(() => "?").join(",");
  const indexes = db
    .prepare(
      `SELECT min(sequence) AS sequence FROM conversation_history_journal WHERE session_id IN (${placeholders}) AND sequence>? GROUP BY table_name,record_key ORDER BY min(sequence)`,
    )
    .all(...sessionIds, cursor) as { sequence: number }[];
  for (const index of indexes) {
    const row = db
      .prepare("SELECT * FROM conversation_history_journal WHERE sequence=?")
      .get(index.sequence) as HistoryUndo;
    if (
      row.table_name !== "agent_runtime_sessions" &&
      !HISTORY_TABLES.includes(
        row.table_name as (typeof HISTORY_TABLES)[number],
      )
    )
      throw new Error("Unknown history journal table.");
    visit(row);
  }
}
function scopeAt(sessionId: string, boundary: HistoryBoundary): string[] {
  return [
    ...new Set([
      ...boundary.sessionIds,
      ...agentRuntimeStore.listSessionTree(sessionId).map((s) => s.id),
    ]),
  ];
}
function removeUnacceptedRun(
  state: HistoryState,
  runId: string | undefined,
): void {
  if (runId)
    state.tables.agent_runtime_runs = state.tables.agent_runtime_runs.filter(
      (r) => r.id !== runId,
    );
}
/** Materialization is only needed for an explicit fork/legacy trim, never capture. */
export function historyAtBoundary(
  sessionId: string,
  boundary: HistoryBoundary,
): HistoryState {
  const state = readHistory(sessionId);
  if (boundary.legacy) return legacyPrefix(state, sessionId, boundary);
  const maps = new Map<string, Map<string, Row>>();
  maps.set(
    "agent_runtime_sessions",
    new Map(state.sessions.map((r) => [String(r.id), r])),
  );
  for (const table of HISTORY_TABLES)
    maps.set(
      table,
      new Map(state.tables[table].map((r) => [recordKey(table, r), r])),
    );
  eachUndo(scopeAt(sessionId, boundary), boundary.cursor, (row) => {
    const records = maps.get(row.table_name)!;
    if (row.before_json === null) records.delete(row.record_key);
    else records.set(row.record_key, JSON.parse(row.before_json));
  });
  state.sessions = [...maps.get("agent_runtime_sessions")!.values()];
  for (const table of HISTORY_TABLES)
    state.tables[table] = [...maps.get(table)!.values()];
  state.tables.agent_runtime_messages.sort(
    (a, b) => Number(a.sequence) - Number(b.sequence),
  );
  removeUnacceptedRun(state, boundary.omitRunId);
  return state;
}
export function restoreHistoryBoundary(
  sessionId: string,
  boundary: HistoryBoundary,
): void {
  const db = getRawSqlite(),
    scope = scopeAt(sessionId, boundary);
  const currentRows = new Map(
    scope.map((id) => [
      id,
      db.prepare("SELECT * FROM agent_runtime_sessions WHERE id=?").get(id) as
        | Row
        | undefined,
    ]),
  );
  withoutHistoryJournal(() => {
    if (boundary.legacy)
      replaceHistory(sessionId, historyAtBoundary(sessionId, boundary));
    else {
      eachUndo(scope, boundary.cursor, (row) => {
        if (row.before_json === null)
          deleteRecord(row.table_name, row.record_key);
      });
      eachUndo(scope, boundary.cursor, (row) => {
        if (row.before_json !== null) {
          const original = JSON.parse(row.before_json) as Row;
          const value =
            row.table_name === "agent_runtime_sessions"
              ? preserveAuthorization(
                  original,
                  currentRows.get(String(original.id)),
                )
              : original;
          upsertRecord(row.table_name, value);
        }
      });
      if (boundary.omitRunId)
        db.prepare(
          "DELETE FROM agent_runtime_runs WHERE id=? AND session_id=?",
        ).run(boundary.omitRunId, sessionId);
    }
    // Runtime state may not keep executing on a popped branch. These are small
    // per-session/active-record updates; immutable retained messages stay put.
    for (const id of scope) {
      const row = db
        .prepare("SELECT * FROM agent_runtime_sessions WHERE id=?")
        .get(id) as Row | undefined;
      if (row)
        upsertRecord(
          "agent_runtime_sessions",
          cleanMetadata(preserveAuthorization(row, currentRows.get(id))),
        );
      db.prepare(
        "UPDATE agent_runtime_runs SET status=CASE WHEN status IN ('running','queued','waiting_input','waiting_permission') THEN 'interrupted' ELSE status END, metadata_json=json_remove(metadata_json,'$.executionLease','$.recovery') WHERE session_id=?",
      ).run(id);
      db.prepare(
        "UPDATE agent_runtime_run_steps SET status='interrupted',completed_at=?,finish_reason='history_restored' WHERE session_id=? AND status IN ('running','waiting_permission','waiting_input')",
      ).run(nowIso(), id);
      db.prepare(
        "UPDATE agent_runtime_tool_calls SET status='cancelled',ended_at=?,error='History branch was closed.' WHERE session_id=? AND status IN ('pending','running')",
      ).run(nowIso(), id);
      db.prepare(
        "UPDATE agent_runtime_interactions SET status='cancelled',resolved_at=? WHERE session_id=? AND status='pending'",
      ).run(nowIso(), id);
      db.prepare(
        "UPDATE agent_runtime_permissions SET action='deny',user_reply='reject',resolved_at=?,resume_token=NULL WHERE session_id=? AND resolved_at IS NULL",
      ).run(nowIso(), id);
      db.prepare(
        "DELETE FROM agent_runtime_stream_records WHERE session_id=?",
      ).run(id);
    }
    const placeholders = scope.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM conversation_history_journal WHERE session_id IN (${placeholders}) AND sequence>?`,
    ).run(...scope, boundary.cursor);
    for (const id of scope)
      db.prepare(
        "UPDATE conversation_history_tracking SET last_boundary=? WHERE session_id=?",
      ).run(boundary.cursor, id);
    const readCursor=(db.prepare("SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_history_journal").get() as {cursor:number}).cursor;
    for(const id of scope) db.prepare("UPDATE agent_runtime_sessions SET session_metadata_json=json_set(COALESCE(session_metadata_json,'{}'),'$.fileReadHistoryBoundary',?) WHERE id=?").run(readCursor,id);

  });
}

/** Old failures have real message positions, not old file/state snapshots. Keep
 * only records that can be tied to the retained transcript, reset derived caches. */
function legacyPrefix(
  state: HistoryState,
  sessionId: string,
  boundary: HistoryBoundary,
): HistoryState {
  if (boundary.messageSequence == null)
    throw new Error("Legacy checkpoint has no surviving message anchor.");
  const messages = state.tables.agent_runtime_messages.filter(
    (r) =>
      r.session_id === sessionId &&
      Number(r.sequence) <= boundary.messageSequence!,
  );
  const runIds = new Set<Row[string]>(messages.flatMap((m) => (m.run_id ? [m.run_id] : [])));
  const last = messages.at(-1);
  const steps = state.tables.agent_runtime_run_steps.filter((r) =>
    runIds.has(r.run_id),
  );
  let finalStep = last?.step_id
    ? steps.find((s) => s.id === last.step_id)
    : undefined;
  if (!finalStep && last?.role === "assistant" && last.run_id)
    finalStep = steps
      .filter((s) => s.run_id === last.run_id)
      .sort((a, b) => Number(a.step_index) - Number(b.step_index))
      .at(-1);
  const retainedSteps = steps.filter(
    (s) =>
      s.run_id !== last?.run_id ||
      (finalStep && Number(s.step_index) <= Number(finalStep.step_index)),
  );
  const stepIds = new Set<Row[string]>(retainedSteps.map((s) => s.id));
  for (const table of HISTORY_TABLES) {
    if (table === "agent_runtime_messages") state.tables[table] = messages;
    else if (table === "agent_runtime_runs")
      state.tables[table] = state.tables[table].filter(
        (r) => r.session_id === sessionId && runIds.has(r.id),
      );
    else if (table === "agent_runtime_run_steps")
      state.tables[table] = retainedSteps;
    else if (
      ["agent_runtime_run_parts", "agent_runtime_tool_calls"].includes(table)
    )
      state.tables[table] = state.tables[table].filter(
        (r) => r.session_id === sessionId && stepIds.has(r.step_id),
      );
    else if (table === "agent_runtime_asset_sessions")
      state.tables[table] = state.tables[table].filter(
        (r) => r.session_id === sessionId,
      );
    else state.tables[table] = [];
  }
  state.sessions = state.sessions
    .filter((r) => r.id === sessionId)
    .map((row) => {
      const meta = JSON.parse(String(row.session_metadata_json ?? "{}")) ?? {};
      for (const key of [
        "activeWorkId",
        "goal",
        "plan",
        "contextEpoch",
        "contextMemory",
        "contextCompaction",
        "inputQueue",
        "inputForceInjectId",
        "turnReferences",
      ])
        delete meta[key];
      return {
        ...row,
        context_snapshot_id: null,
        child_session_ids_json: "[]",
        result_summary: null,
        session_metadata_json: JSON.stringify(meta),
      };
    });
  // Cached summaries and provider request snapshots must not import the removed suffix.
  state.tables.agent_runtime_run_steps =
    state.tables.agent_runtime_run_steps.map((row) => {
      const meta = JSON.parse(String(row.metadata_json ?? "{}")) ?? {};
      for (const key of [
        "contextMemorySegment",
        "contextCompaction",
        "runtimeReminder",
      ])
        delete meta[key];
      return { ...row, metadata_json: JSON.stringify(meta) };
    });
  return state;
}

/** Reads from a discarded future (or from old content retained alongside newer
 * committed files) cannot authorize a blind write in the new history branch. */
export function filterHistoryFileReads<T extends {id:string}>(sessionId:string,calls:T[]):T[] {
  const db=getRawSqlite();
  const row=db.prepare("SELECT json_extract(session_metadata_json,'$.fileReadHistoryBoundary') AS cursor FROM agent_runtime_sessions WHERE id=?").get(sessionId) as {cursor:number|null}|undefined;
  if(row?.cursor==null)return calls;
  const ids=new Set((db.prepare("SELECT record_key FROM conversation_history_journal WHERE session_id=? AND table_name='agent_runtime_tool_calls' AND before_json IS NULL AND sequence>?").all(sessionId,row.cursor) as {record_key:string}[]).map(record=>record.record_key));
  return calls.filter(call=>ids.has(call.id));
}
