import { getRawSqlite } from "../../infrastructure/database/index.js";
import { mapLegacyHistoryRow } from "./session-store.js";
import { readVersionSnapshot } from "./checkpoints/version-store/read-snapshot.js";
import { simpleHistoryRevision } from "./simple-history.js";
import { AgentRuntimeError } from "./runtime-errors.js";

const BODY_LIMIT = 8192;
const bodyColumns: Record<string, string> = {
  content: "content",
  metadata_json: "metadata",
  content_parts_json: "contentParts",
  input_ref_json: "inputRef",
  output_ref_json: "outputRef",
  output_summary: "outputSummary",
  payload_json: "payload",
};
const projections = new WeakMap<object, Map<string, string>>();
function projection(table: string): string {
  const db = getRawSqlite();
  let cache = projections.get(db);
  if (!cache) projections.set(db, (cache = new Map()));
  const found = cache.get(table);
  if (found) return found;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  const sql = columns
    .flatMap(({ name }) => {
      if (!(name in bodyColumns)) return [`"${name}"`];
      const large = `length(CAST("${name}" AS BLOB))>${BODY_LIMIT}`;
      const fallback = name.endsWith("_json")
        ? name === "content_parts_json"
          ? "'[]'"
          : "'{}'"
        : `substr("${name}",1,2048)`;
      return [
        `CASE WHEN ${large} THEN ${fallback} ELSE "${name}" END AS "${name}"`,
        `CASE WHEN ${large} THEN 1 ELSE 0 END AS "_large_${name}"`,
      ];
    })
    .join(",");
  cache.set(table, sql);
  return sql;
}
function decode(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const result = mapLegacyHistoryRow(table, row);
  const omitted = Object.entries(bodyColumns)
    .filter(([column]) => row[`_large_${column}`])
    .map(([, field]) => field);
  if (omitted.length) result.historyProjection = { omittedFields: omitted };
  return result;
}
function select(
  table: string,
  where: string,
  args: unknown[],
  order: string,
  limit: number,
) {
  return (
    getRawSqlite()
      .prepare(
        `SELECT ${projection(table)} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`,
      )
      .all(...args, limit) as Record<string, unknown>[]
  ).map((row) => decode(table, row));
}
function inList(ids: unknown[]): { clause: string; args: string[] } {
  const args = [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && Boolean(id)),
    ),
  ];
  return { clause: args.length ? args.map(() => "?").join(",") : "NULL", args };
}
function stale(): never {
  throw new AgentRuntimeError(
    "Conversation changed. Refresh history.",
    "HISTORY_STALE",
    409,
  );
}
function epoch(sessionId: string): number {
  const row = getRawSqlite()
    .prepare("SELECT epoch FROM conversation_flat_heads WHERE session_id=?")
    .get(sessionId) as { epoch: number } | undefined;
  if (!row) stale();
  return row.epoch;
}
export function readFlatHistoryWindow(sessionId: string, cursor?: string) {
  return readVersionSnapshot(getRawSqlite(), () => {
    const generation = epoch(sessionId),
      revision = simpleHistoryRevision(sessionId);
    let before: { sequence: number; id: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 2048) stale();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.sessionId !== sessionId ||
          decoded.epoch !== generation ||
          !Number.isSafeInteger(decoded.sequence) ||
          typeof decoded.id !== "string"
        )
          stale();
        before = decoded;
      } catch {
        stale();
      }
    }
    const db = getRawSqlite();
    const raw = db
      .prepare(
        `SELECT ${projection("agent_runtime_messages")} FROM agent_runtime_messages WHERE session_id=?
      ${before ? "AND (sequence,id)<(?,?)" : ""} ORDER BY sequence DESC,id DESC LIMIT 25`,
      )
      .all(
        sessionId,
        ...(before ? [before.sequence, before.id] : []),
      ) as Record<string, unknown>[];
    const hasEarlier = raw.length > 24;
    raw.length = Math.min(raw.length, 24);
    const last = raw.at(-1);
    const messages = raw
      .map((row) => decode("agent_runtime_messages", row))
      .reverse();
    const stepIds = inList(messages.map((message) => message.stepId));
    const steps = select(
      "agent_runtime_run_steps",
      `session_id=? AND (id IN (${stepIds.clause}) ${cursor ? "" : "OR started_at>=?"})`,
      [
        sessionId,
        ...stepIds.args,
        ...(cursor ? [] : [messages[0]?.createdAt ?? ""]),
      ],
      "started_at DESC,id DESC",
      49,
    );
    let detailsTruncated = steps.length > 48;
    steps.length = Math.min(steps.length, 48);
    steps.reverse();
    const relatedSteps = inList(steps.map((step) => step.id));
    const runIds = inList([...messages, ...steps].map((row) => row.runId));
    const runs = select(
      "agent_runtime_runs",
      `session_id=? AND id IN (${runIds.clause})`,
      [sessionId, ...runIds.args],
      "started_at DESC,id DESC",
      48,
    );
    const toolCalls = select(
      "agent_runtime_tool_calls",
      `session_id=? AND step_id IN (${relatedSteps.clause})`,
      [sessionId, ...relatedSteps.args],
      "started_at DESC,id DESC",
      97,
    );
    detailsTruncated ||= toolCalls.length > 96;
    toolCalls.length = Math.min(toolCalls.length, 96);
    toolCalls.reverse();
    return {
      messages,
      steps,
      runs,
      toolCalls,
      events: cursor
        ? []
        : select(
            "agent_runtime_events",
            "session_id=?",
            [sessionId],
            "timestamp DESC,id DESC",
            32,
          ).reverse(),
      permissions: cursor
        ? []
        : select(
            "agent_runtime_permissions",
            "session_id=?",
            [sessionId],
            "created_at DESC,id DESC",
            32,
          ).reverse(),
      historyWindow: {
        storage: "sqlite-flat" as const,
        revision,
        epoch: generation,
        cursor,
        latest: !cursor,
        hasEarlier,
        detailsTruncated,
        olderCursor:
          hasEarlier && last
            ? Buffer.from(
                JSON.stringify({
                  sessionId,
                  epoch: generation,
                  sequence: last.sequence,
                  id: last.id,
                }),
              ).toString("base64url")
            : undefined,
      },
    };
  });
}
/** Lightweight navigation; never fetch tool bodies just to build the rail. */
export function readFlatTimeline(
  sessionId: string,
  before = Number.MAX_SAFE_INTEGER,
) {
  return readVersionSnapshot(getRawSqlite(), () => {
    const rows = getRawSqlite()
      .prepare(
        `SELECT id,sequence,role,run_id AS runId,step_id AS stepId,substr(content,1,256) AS content,created_at AS createdAt
      FROM agent_runtime_messages WHERE session_id=? AND sequence<? AND role IN ('user','assistant') ORDER BY sequence DESC LIMIT 257`,
      )
      .all(sessionId, before) as Record<string, unknown>[];
    const more = rows.length > 256;
    rows.length = Math.min(rows.length, 256);
    return {
      items: rows.map((row) => ({ ...row, sessionId, metadata: {} })).reverse(),
      next: more ? Number(rows.at(-1)!.sequence) : undefined,
      epoch: epoch(sessionId),
    };
  });
}
