import {
  versionRepository,
  versionedSession,
} from "./version-runtime/bridge.js";
import { ensureHistoryAccess } from "./retention.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { historyError } from "./guards.js";
import { captureHistoryBoundary, type HistoryBoundary } from "./state.js";

export interface CheckpointPayload {
  version: 2 | 3;
  versionId?: string;
  boundary: HistoryBoundary;
}
export interface ConversationCheckpoint {
  id: string;
  sessionId: string;
  ordinal: number;
  kind: "input" | "reply";
  messageId: string | null;
  stepId: string | null;
  mutationCursor: number;
  payload: CheckpointPayload;
  createdAt: string;
}
interface CheckpointRow {
  id: string;
  session_id: string;
  ordinal: number;
  kind: "input" | "reply";
  message_id: string | null;
  step_id: string | null;
  mutation_cursor: number;
  payload_json: string;
  created_at: string;
}
function fromRow(row: CheckpointRow): ConversationCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    kind: row.kind,
    messageId: row.message_id,
    stepId: row.step_id,
    mutationCursor: row.mutation_cursor,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}
export function listCheckpoints(sessionId: string): ConversationCheckpoint[] {
  if (versionedSession(sessionId)) {
    const page = versionRepository().checkpoints(sessionId);
    if (page.next)
      throw historyError(
        "Checkpoint pagination required.",
        "HISTORY_PAGE_REQUIRED",
      );
    return page.items;
  }
  return (
    getRawSqlite()
      .prepare(
        "SELECT * FROM conversation_checkpoints WHERE session_id=? ORDER BY ordinal",
      )
      .all(sessionId) as CheckpointRow[]
  ).map(fromRow);
}
export function getCheckpoint(
  sessionId: string,
  id: string,
): ConversationCheckpoint {
  if (versionedSession(sessionId))
    return versionRepository().checkpoint(sessionId, id);
  const row = getRawSqlite()
    .prepare(
      "SELECT * FROM conversation_checkpoints WHERE id=? AND session_id=?",
    )
    .get(id, sessionId) as CheckpointRow | undefined;
  if (!row)
    throw historyError(
      "This history checkpoint is no longer available.",
      "CHECKPOINT_NOT_FOUND",
    );
  return fromRow(row);
}
export function mutationCursor(): number {
  return (
    getRawSqlite()
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_mutations",
      )
      .get() as { cursor: number }
  ).cursor;
}
export function nativeCheckpointSession(sessionId: string): boolean {
  const session = agentRuntimeStore.getSession(sessionId);
  const backend = session.sessionMetadata?.backend as
    | { id?: string }
    | undefined;
  return (!backend?.id || backend.id === "native") && !session.parentSessionId;
}
export async function captureCheckpoint(
  sessionId: string,
  kind: "input" | "reply",
  messageId: string,
  stepId: string | null = null,
  omitRunId?: string,
): Promise<ConversationCheckpoint | null> {
  if (!nativeCheckpointSession(sessionId)) return null;
  if (versionedSession(sessionId))
    return versionRepository().capture(
      sessionId,
      kind,
      messageId,
      stepId,
      mutationCursor(),
      omitRunId,
    );
  const db = getRawSqlite();
  const checkpoint = db.transaction(() => {
    const previous = db
      .prepare(
        "SELECT * FROM conversation_checkpoints WHERE session_id=? AND kind=? AND message_id=? LIMIT 1",
      )
      .get(sessionId, kind, messageId) as CheckpointRow | undefined;
    if (previous) return fromRow(previous);
    ensureHistoryAccess(sessionId);
    const boundary = captureHistoryBoundary(sessionId, omitRunId);
    const id = `checkpoint_${randomUUID()}`;
    const ordinal = (
      db
        .prepare(
          "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM conversation_checkpoints WHERE session_id=?",
        )
        .get(sessionId) as { ordinal: number }
    ).ordinal;
    db.prepare(
      `INSERT INTO conversation_checkpoints(id,session_id,ordinal,kind,message_id,step_id,mutation_cursor,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      sessionId,
      ordinal,
      kind,
      messageId,
      stepId,
      mutationCursor(),
      JSON.stringify({ version: 2, boundary }),
      new Date().toISOString(),
    );
    return getCheckpoint(sessionId, id);
  })();
  emitRuntimeBusEvent({ type: "session_checkpoint_changed", sessionId });
  return checkpoint;
}
export async function captureCompletedReply(
  sessionId: string,
  stepId?: string,
): Promise<void> {
  if (!nativeCheckpointSession(sessionId)) return;
  const message = getRawSqlite()
    .prepare(
      `SELECT id,step_id AS stepId FROM agent_runtime_messages WHERE session_id=? AND role='assistant'
    AND (trim(content)<>'' OR content_parts_json IS NOT NULL)
    AND COALESCE(json_extract(metadata_json,'$.type'),'')<>'thinking'
    AND COALESCE(json_extract(metadata_json,'$.kind'),'')<>'thought'
    AND COALESCE(json_extract(metadata_json,'$.partial'),0)=0 ${stepId ? "AND step_id=?" : ""}
    ORDER BY sequence DESC,created_at DESC LIMIT 1`,
    )
    .get(...(stepId ? [sessionId, stepId] : [sessionId])) as
    | { id: string; stepId: string | null }
    | undefined;
  if (!message) return;
  if (message.stepId) {
    const step = agentRuntimeStore.getRunStep(message.stepId);
    if (!["completed", "blocked"].includes(step.status)) return;
  }
  await captureCheckpoint(sessionId, "reply", message.id, message.stepId);
}
