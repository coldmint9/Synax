import { resolveSessionWorkspaceRoots } from "../tools/workspace.js";
import { withSnapshotLease } from "./storage-leases.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { checkpointFiles, type FileManifest } from "./files.js";
import {
  historyRevision,
  sessionRoots,
  rootsOverlap,
  historyError,
} from "./guards.js";
import { readHistory, type HistoryState } from "./state.js";
import { logger } from "../../../lib/logger.js";

export interface CheckpointPayload {
  version: 1;
  policyVersion: 1;
  history?: HistoryState;
  manifests?: FileManifest[];
  error?: string;
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
  return withSnapshotLease(() =>
    captureCheckpointInsideLease(sessionId, kind, messageId, stepId, omitRunId),
  );
}
async function captureCheckpointInsideLease(
  sessionId: string,
  kind: "input" | "reply",
  messageId: string,
  stepId: string | null = null,
  omitRunId?: string,
): Promise<ConversationCheckpoint | null> {
  if (!nativeCheckpointSession(sessionId)) return null;
  const db = getRawSqlite();
  const previous = db
    .prepare(
      "SELECT * FROM conversation_checkpoints WHERE session_id=? AND kind=? AND message_id=? LIMIT 1",
    )
    .get(sessionId, kind, messageId) as CheckpointRow | undefined;
  if (previous) return fromRow(previous);
  const revision = historyRevision(sessionId),
    cursor = mutationCursor();
  let payload: CheckpointPayload;
  try {
    const roots = sessionRoots(sessionId);
    if (!roots.length)
      throw new Error("No workspace is bound to this session.");
    const overlaps = (rows: { roots_json: string }[]) =>
      rows.some((row) =>
        (JSON.parse(row.roots_json) as string[]).some((a) =>
          roots.some((b) => rootsOverlap(a, b)),
        ),
      );
    if (
      overlaps(
        db
          .prepare(
            "SELECT roots_json FROM conversation_mutations WHERE state='open'",
          )
          .all() as { roots_json: string }[],
      )
    )
      throw new Error("Workspace writes are still in flight.");
    const history = readHistory(sessionId, omitRunId);
    for (const row of history.sessions) {
      const metadata =
        JSON.parse(String(row.session_metadata_json ?? "{}")) ?? {};
      if (metadata.backend && !metadata.backend.workspaceRoots) {
        const bindings = resolveSessionWorkspaceRoots(
          String(row.id),
          String(row.project_id),
        );
        metadata.backend.workspaceRoots = bindings;
        row.session_metadata_json = JSON.stringify(metadata);
      }
    }
    if (
      history.sessions.some((row) =>
        db
          .prepare(
            "SELECT id FROM agent_runtime_processes WHERE session_id=? AND kind='background' AND state<>'closed'",
          )
          .get(row.id),
      )
    )
      throw new Error(
        "Stop background writers before creating a recoverable checkpoint.",
      );
    const manifests = await Promise.all(
      roots.map((root) => checkpointFiles.capture(root)),
    );
    if (
      historyRevision(sessionId) !== revision ||
      overlaps(
        db
          .prepare(
            "SELECT roots_json FROM conversation_mutations WHERE sequence>?",
          )
          .all(cursor) as { roots_json: string }[],
      )
    )
      throw new Error("Workspace changed while capturing the checkpoint.");
    payload = { version: 1, policyVersion: 1, history, manifests };
  } catch (error) {
    payload = {
      version: 1,
      policyVersion: 1,
      error: error instanceof Error ? error.message : String(error),
    };
    logger.warn(
      { sessionId, error: payload.error },
      "[history] checkpoint unavailable",
    );
  }
  const id = `checkpoint_${randomUUID()}`;
  db.transaction(() => {
    if (historyRevision(sessionId) !== revision) return;
    const ordinal =
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM conversation_checkpoints WHERE session_id=?",
          )
          .get(sessionId) as { ordinal: number }
      ).ordinal + 1;
    db.prepare(
      `INSERT INTO conversation_checkpoints(id,session_id,ordinal,kind,message_id,step_id,mutation_cursor,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mutation_cursor=excluded.mutation_cursor,payload_json=excluded.payload_json`,
    ).run(
      id,
      sessionId,
      ordinal,
      kind,
      messageId,
      stepId,
      cursor,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  })();
  emitRuntimeBusEvent({ type: "session_checkpoint_changed", sessionId });
  return getCheckpoint(sessionId, id);
}
export async function captureCompletedReply(
  sessionId: string,
  stepId?: string,
): Promise<void> {
  if (!nativeCheckpointSession(sessionId)) return;
  const messages = agentRuntimeStore
    .listMessages(sessionId)
    .filter(
      (m) =>
        m.role === "assistant" &&
        m.metadata?.type !== "thinking" &&
        m.metadata?.kind !== "thought" &&
        !m.metadata?.partial &&
        (m.content.trim() || m.contentParts?.length) &&
        (!stepId || m.stepId === stepId),
    );
  const message = messages.at(-1);
  if (!message) return;
  if (message.stepId) {
    const step = agentRuntimeStore.getRunStep(message.stepId);
    if (!["completed", "blocked"].includes(step.status)) return;
  }
  await captureCheckpoint(sessionId, "reply", message.id, message.stepId);
}
