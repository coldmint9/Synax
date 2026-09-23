import type Database from "libsql";
import { getRawSqlite } from "../../../../db/index.js";
import { AgentRuntimeError } from "../../runtime-errors.js";
import { mapLegacyHistoryRow } from "../../session-store.js";
import { versionRepository } from "./bridge.js";
import { readVersionSnapshot } from "../version-store/read-snapshot.js";
import { admitVersionGrowth } from "../resource-admission.js";

export const diagnosticTables: Record<string, string> = {
  work: "agent_runtime_work", contexts: "agent_runtime_context_bundles", compactions: "agent_runtime_compaction_summaries",
  events: "agent_runtime_events",
  runs: "agent_runtime_runs",
  steps: "agent_runtime_run_steps",
  parts: "agent_runtime_run_parts",
  tools: "agent_runtime_tool_calls",
  permissions: "agent_runtime_permissions",
  artifacts: "agent_runtime_artifacts",
  thinking: "agent_runtime_thinking_summaries",
  interactions: "agent_runtime_interactions",
};
export const isDiagnostic = (kind: string): boolean =>
  Object.hasOwn(diagnosticTables, kind) && !["work", "contexts", "compactions"].includes(kind);
const projections = new WeakMap<Database.Database, Map<string, string>>();
function table(kind: string): string {
  const value = diagnosticTables[kind];
  if (!value) throw new Error("Unsupported diagnostic table.");
  return value;
}
/** One scalar sequence and one locator, no immutable snapshot of the row. Caller
 * owns the transaction containing the original raw-table write. */
export function trackDiagnostic(
  sessionId: string,
  kind: string,
  id: string,
): void {
  const db = getRawSqlite();
  admitVersionGrowth(db, 1024);
  const state = db
    .prepare(
      "UPDATE conversation_v3_heads SET runtime_sequence=runtime_sequence+1 WHERE session_id=? RETURNING epoch,runtime_sequence AS sequence",
    )
    .get(sessionId) as { epoch: number; sequence: number };
  db.prepare(
    `INSERT INTO conversation_v3_runtime_records(session_id,kind,record_id,epoch,sequence) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,kind,record_id) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence`,
  ).run(sessionId, kind, id, state.epoch, state.sequence);
}
function visible(
  sessionId: string,
  kind: string,
  id: string,
): { epoch: number } | undefined {
  const db = getRawSqlite();
  const locator = db
    .prepare(
      "SELECT epoch,sequence FROM conversation_v3_runtime_records WHERE session_id=? AND kind=? AND record_id=?",
    )
    .get(sessionId, kind, id) as
    | { epoch: number; sequence: number }
    | undefined;
  if (!locator) {
    const legacy = (
      db
        .prepare(
          "SELECT legacy_runtime FROM conversation_v3_heads WHERE session_id=?",
        )
        .get(sessionId) as { legacy_runtime: number }
    ).legacy_runtime;
    return legacy ? { epoch: 0 } : undefined;
  }
  const through = versionRepository().runtimeVisibility(
    sessionId,
    locator.epoch,
  );
  return through !== undefined && locator.sequence <= through
    ? locator
    : undefined;
}
export function diagnosticVisible(
  sessionId: string,
  kind: string,
  id: string,
): boolean {
  return Boolean(visible(sessionId, kind, id));
}
function projection(kind: string, preview: boolean): string {
  const db = getRawSqlite();
  let cache = projections.get(db);
  if (!cache) projections.set(db, (cache = new Map()));
  const key = `${kind}:${preview}`;
  if (cache.has(key)) return cache.get(key)!;
  const columns = (
    db.prepare(`PRAGMA table_info(${table(kind)})`).all() as {
      name: string;
      type: string;
    }[]
  ).filter((column) => column.name !== "_metadata");
  const size = columns
    .map((c) => `COALESCE(length(CAST("${c.name}" AS BLOB)),0)`)
    .join("+");
  const sql = columns
    .map((c) => {
      const name = `"${c.name}"`;
      if (!preview)
        return `CASE WHEN ${size}<=1048576 THEN ${name} ELSE NULL END AS ${name}`;
      if (!/TEXT/i.test(c.type)) return name;
      const fallback = c.name.endsWith("_json")
        ? `'${["content_parts_json", "patterns_json", "source_refs_json"].includes(c.name) ? "[]" : "{}"}'`
        : `substr(${name},1,1024)||' [truncated]'`;
      return `CASE WHEN length(CAST(${name} AS BLOB))<=4096 THEN ${name} ELSE ${fallback} END AS ${name}`;
    })
    .join(",");
  cache.set(key, sql);
  return sql;
}
export function readDiagnostic(
  sessionId: string,
  kind: string,
  id: string,
  preview = false,
): Record<string, unknown> | undefined {
  return readVersionSnapshot(getRawSqlite(), () => {
    const location = visible(sessionId, kind, id);
    if (!location) return undefined;
    const row = getRawSqlite()
      .prepare(
        `SELECT ${projection(kind, preview)} FROM ${table(kind)} WHERE session_id=? AND id=?`,
      )
      .get(sessionId, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (!row.id)
      throw new AgentRuntimeError(
        "Execution detail exceeds the materialization budget; use its preview.",
        "HISTORY_PAGE_REQUIRED",
        413,
      );
    return {
      ...mapLegacyHistoryRow(table(kind), row),
      __synaxExecutionEpoch: location.epoch,
    };
  });
}
export function diagnosticPage(
  sessionId: string,
  kind: string,
  options: {
    limit?: number;
    scope?: { field: string; value: string };
    preview?: boolean;
    types?: readonly string[];
  } = {},
): { items: Record<string, unknown>[]; truncated: boolean } {
  return readVersionSnapshot(getRawSqlite(), () => {
    const db = getRawSqlite(),
      limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new AgentRuntimeError(
        "Invalid detail page limit.",
        "VALIDATION_ERROR",
        400,
      );
    const scope = options.scope;
    if (scope && !["runId", "stepId"].includes(scope.field))
      throw new Error("Invalid detail scope.");
    const filter = scope
      ? ` AND t.${scope.field === "runId" ? "run_id" : "step_id"}=?`
      : "";
    const types = options.types?.length
      ? ` AND t.type IN (${options.types.map(() => "?").join(",")})`
      : "";
    const values = [...(scope ? [scope.value] : []), ...(options.types ?? [])];
    const identities: string[] = [];
    let truncated = false;
    for (const range of versionRepository().runtimeEpochs(sessionId)) {
      const rows = db
        .prepare(
          `SELECT r.record_id AS id FROM conversation_v3_runtime_records r
        JOIN ${table(kind)} t ON t.id=r.record_id AND t.session_id=r.session_id
        WHERE r.session_id=? AND r.kind=? AND r.epoch=? AND r.sequence<=?${filter}${types}
        ORDER BY r.sequence DESC LIMIT ?`,
        )
        .all(
          sessionId,
          kind,
          range.epoch,
          range.through,
          ...values,
          limit + 1 - identities.length,
        ) as { id: string }[];
      identities.push(...rows.map((row) => row.id));
      if (identities.length > limit) {
        truncated = true;
        identities.length = limit;
        break;
      }
    }
    if (
      identities.length < limit &&
      (
        db
          .prepare(
            "SELECT legacy_runtime FROM conversation_v3_heads WHERE session_id=?",
          )
          .get(sessionId) as { legacy_runtime: number }
      ).legacy_runtime
    ) {
      const rows = db
        .prepare(
          `SELECT t.id FROM ${table(kind)} t WHERE t.session_id=?${filter}${types}
        AND NOT EXISTS(SELECT 1 FROM conversation_v3_runtime_records r WHERE r.session_id=t.session_id AND r.kind=? AND r.record_id=t.id)
        ORDER BY t.rowid DESC LIMIT ?`,
        )
        .all(sessionId, ...values, kind, limit + 1 - identities.length) as {
        id: string;
      }[];
      identities.push(...rows.map((row) => row.id));
      if (identities.length > limit) {
        truncated = true;
        identities.length = limit;
      }
    }
    const items: Record<string, unknown>[] = [];
    let bytes = 0;
    for (const id of identities) {
      const item = readDiagnostic(sessionId, kind, id, options.preview);
      if (!item) continue;
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 1024 * 1024) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    return { items: items.reverse(), truncated };
  });
}

/** Fixed retained event tail across all branches. Authoritative messages and
 * accounting are never touched by this low-value diagnostic cleanup. */
export function trimDiagnosticEvents(sessionId: string): void {
  const db = getRawSqlite();
  const cutoff = db
    .prepare(
      `SELECT sequence FROM conversation_v3_runtime_records
    WHERE session_id=? AND kind='events' ORDER BY sequence DESC LIMIT 1 OFFSET 2048`,
    )
    .get(sessionId) as { sequence: number } | undefined;
  if (!cutoff) return;
  const rows = db
    .prepare(
      "SELECT record_id FROM conversation_v3_runtime_records WHERE session_id=? AND kind='events' AND sequence<=? LIMIT 256",
    )
    .all(sessionId, cutoff.sequence) as { record_id: string }[];
  for (const row of rows) {
    db.prepare(
      "DELETE FROM agent_runtime_events WHERE session_id=? AND id=?",
    ).run(sessionId, row.record_id);
    db.prepare(
      "DELETE FROM conversation_v3_runtime_records WHERE session_id=? AND kind='events' AND record_id=?",
    ).run(sessionId, row.record_id);
  }
}
