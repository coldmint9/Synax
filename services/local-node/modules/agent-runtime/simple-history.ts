import { getRawSqlite } from "../../infrastructure/database/index.js";
import { AgentRuntimeError } from "./runtime-errors.js";

export function simpleHistorySession(sessionId: string): boolean {
  return Boolean(
    getRawSqlite()
      .prepare("SELECT 1 FROM conversation_flat_heads WHERE session_id=?")
      .get(sessionId),
  );
}
export function initializeSimpleHistory(sessionId: string): void {
  getRawSqlite()
    .prepare(
      "INSERT OR IGNORE INTO conversation_flat_heads(session_id) VALUES(?)",
    )
    .run(sessionId);
  getRawSqlite()
    .prepare("DELETE FROM conversation_history_tracking WHERE session_id=?")
    .run(sessionId);
}
export function simpleHistoryRevision(sessionId: string): number {
  return Number(
    (
      getRawSqlite()
        .prepare(
          "SELECT revision FROM conversation_history_versions WHERE session_id=?",
        )
        .get(sessionId) as { revision: number } | undefined
    )?.revision ?? 0,
  );
}
export function bumpSimpleHistoryRevision(sessionId: string): number {
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_history_versions(session_id,revision) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1",
    )
    .run(sessionId);
  return simpleHistoryRevision(sessionId);
}
export interface SimpleHistoryCheckpoint {
  id: string;
  kind: "input" | "reply";
  messageId: string;
  stepId: string | null;
  sequence: number;
  createdAt: string;
  role: string;
}
const eligibility = `role IN ('user','assistant') AND COALESCE(json_extract(metadata_json,'$.partial'),0)=0
  AND COALESCE(json_extract(metadata_json,'$.type'),'')<>'thinking'
  AND COALESCE(json_extract(metadata_json,'$.kind'),'')<>'thought'
  AND (trim(content)<>'' OR content_parts_json IS NOT NULL)
  AND (role='user' OR step_id IS NULL OR EXISTS(SELECT 1 FROM agent_runtime_run_steps s WHERE s.id=agent_runtime_messages.step_id AND s.status IN ('completed','blocked')))`;
type BoundaryRow = {
  id: string;
  stepId: string | null;
  sequence: number;
  createdAt: string;
  role: string;
};
function boundary(row: BoundaryRow): SimpleHistoryCheckpoint {
  return {
    ...row,
    kind: row.role === "user" ? "input" : "reply",
    messageId: row.id,
    id: `flat:${row.id}`,
  };
}
export function simpleHistoryCheckpoints(
  sessionId: string,
  messageIds?: readonly string[],
): SimpleHistoryCheckpoint[] {
  if (messageIds && (!messageIds.length || messageIds.length > 256)) return [];
  const filter = messageIds
    ? `AND id IN (${messageIds.map(() => "?").join(",")})`
    : "";
  return (
    getRawSqlite()
      .prepare(
        `SELECT id,role,step_id AS stepId,sequence,created_at AS createdAt
    FROM agent_runtime_messages WHERE session_id=? AND ${eligibility} ${filter} ORDER BY sequence DESC,id DESC LIMIT 256`,
      )
      .all(sessionId, ...(messageIds ?? [])) as BoundaryRow[]
  )
    .reverse()
    .map(boundary);
}
export function simpleHistoryBoundary(
  sessionId: string,
  checkpointId: string,
): SimpleHistoryCheckpoint {
  const row = checkpointId.startsWith("flat:")
    ? (getRawSqlite()
        .prepare(
          `SELECT id,role,step_id AS stepId,sequence,created_at AS createdAt
    FROM agent_runtime_messages WHERE session_id=? AND id=? AND ${eligibility}`,
        )
        .get(sessionId, checkpointId.slice(5)) as BoundaryRow | undefined)
    : undefined;
  if (!row)
    throw new AgentRuntimeError(
      "The selected conversation boundary no longer exists.",
      "CHECKPOINT_NOT_FOUND",
      404,
    );
  return boundary(row);
}
export function removedMessageCount(
  sessionId: string,
  point: SimpleHistoryCheckpoint,
): number {
  return (
    getRawSqlite()
      .prepare(
        `SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=? AND sequence${point.kind === "input" ? ">=" : ">"}?`,
      )
      .get(sessionId, point.sequence) as { n: number }
  ).n;
}
