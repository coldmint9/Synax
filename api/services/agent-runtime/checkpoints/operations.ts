import {
  writeFileJournal as writeJournal,
  FILE_JOURNAL_BYTES,
  type JournalPayload,
} from "./file-journal.js";
import { applyVersionFileHistory } from "./version-runtime/file-operation.js";
import { applyVersionHistory } from "./version-runtime/history-operation.js";
import {
  appendOnlySession,
  versionRepository,
  versionedSession,
  assertVersionTranscriptOperation,
} from "./version-runtime/bridge.js";
import { clearSessionFileReads } from "../read-tracker.js";
import { planFileUndo, type PreservedFile } from "./file-plan.js";
import { committedFileReason } from "./git-boundary.js";
import { recoverOrphanedCheckpointWriters } from "./mutations.js";
import { sessionLiveBus } from "../session-live-bus.js";
import { recoverForkOperation } from "./fork.js";
import { initializeGoal } from "../goal-control.js";
import { createHash, randomUUID } from "node:crypto";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { acceptRuntimeRun } from "../run-admission.js";
import type { StreamTurnRequest } from "../contracts.js";
import { invalidateSessionEnvironment } from "../session-environment.js";
import { emitRuntimeBusEvent } from "../runtime-bus-bridge.js";
import {
  checkpointFiles,
  sameVersion,
  SNAPSHOT_EXCLUSIONS,
  type FileChange,
  type FileConflict,
} from "./files.js";
import { getCheckpoint, type ConversationCheckpoint } from "./store.js";
import {
  acquireHistoryLocks,
  activeHistoryOperations as activeOperations,
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyError,
  historyRevision,
  releaseHistoryLocks,
  rootOwner,
  rootsOverlap,
  sessionRoots,
} from "./guards.js";
import { restoreHistoryBoundary } from "./state.js";

export interface HistoryRequest {
  checkpointId: string;
  revision: number;
  requestId: string;
  action: "rollback" | "edit";
  includeFiles?: boolean;
  message?: string;
}
export interface HistoryPreview {
  checkpointId: string;
  revision: number;
  removedMessages: number;
  files: Array<{ root: string; path: string; action: "delete" | "restore" }>;
  conflicts: FileConflict[];
  exclusions: string;
  canApply: boolean;
  warnings: string[];
  preservedFiles: PreservedFile[];
}
export interface HistoryResult {
  sessionId: string;
  revision: number;
  runId?: string;
  input?: StreamTurnRequest;
}
interface Mutation {
  sequence: number;
  owner_session_id: string;
  roots_json: string;
  changes_json: string;
  uncertain: number;
  state: string;
}
const operationId = (sessionId: string, requestId: string) =>
  `history_${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex")}`;
function supported(sessionId: string): void {
  const session = agentRuntimeStore.getSession(sessionId);
  const backend = session.sessionMetadata?.backend as
    | { id?: string }
    | undefined;
  if (session.parentSessionId || (backend?.id && backend.id !== "native"))
    throw historyError(
      "History operations currently require a native root session.",
      "HISTORY_UNSUPPORTED",
    );
}
function assertCheckpoint(checkpoint: ConversationCheckpoint): void {
  // Legacy compatibility must not reintroduce the original event-loop stall.
  // Check bounded identities only; never load the undo bodies before admission.
  const ids = checkpoint.payload.boundary?.sessionIds ?? [checkpoint.sessionId];
  if (ids.length > 64) throw historyError("Legacy history exceeds the bounded rollback budget. Upgrade the inactive conversation first.", "HISTORY_MIGRATION_REQUIRED");
  if (ids.length && getRawSqlite().prepare(`SELECT 1 FROM conversation_history_journal WHERE session_id IN (${ids.map(() => "?").join(",")}) AND sequence>? LIMIT 1 OFFSET 1024`)
      .get(...ids, checkpoint.payload.boundary?.cursor ?? 0))
    throw historyError("Legacy rollback would replay too many undo records. Stop the conversation and use Upgrade history; its current messages will be preserved.", "HISTORY_MIGRATION_REQUIRED");

  if (
    checkpoint.payload.version !== 2 ||
    !checkpoint.payload.boundary ||
    (checkpoint.payload.boundary.legacy &&
      checkpoint.payload.boundary.messageSequence == null)
  )
    throw historyError(
      "No surviving conversation boundary is available.",
      "CHECKPOINT_UNAVAILABLE",
    );
}

export function checkpointSummary(sessionId: string) {
  if (versionedSession(sessionId)) {
    const repo = versionRepository(),
      head = repo.head(sessionId),
      page = repo.checkpoints(sessionId, { limit: 128, reverse: true });
    let reason: string | null = null;
    try {
      supported(sessionId);
      assertHistoryUnlocked(sessionId, []);
      assertHistoryIdle(sessionId);
    } catch (error) {
      reason = (error as Error).message;
    }
    return {
      sessionId,
      revision: head.revision,
      recoveryRequired: Boolean(
        getRawSqlite()
          .prepare(
            "SELECT id FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing') LIMIT 1",
          )
          .get(sessionId),
      ),
      reason,
      rollbackEnabled: !appendOnlySession(sessionId),
      checkpoints: appendOnlySession(sessionId) ? []
        : page.items.map((cp) => ({
        id: cp.id,
        kind: cp.kind,
        messageId: cp.messageId,
        stepId: cp.stepId,
        available: true,
        reason: null,
        hasLaterHistory:
          cp.kind === "input" || cp.payload.versionId !== head.versionId,
        initialInput:
          cp.kind === "input" && cp.payload.boundary.messageCount === 0,
      })),
      ...(page.next ? { next: page.next } : {}),
    };
  }
  const session = agentRuntimeStore.getSession(sessionId);
  recoverOrphanedCheckpointWriters();
  let reason: string | null = null;
  try {
    supported(sessionId);
    assertHistoryUnlocked(sessionId);
    assertHistoryIdle(sessionId);
  } catch (error) {
    reason = (error as Error).message;
  }
  const db = getRawSqlite();
  // Do not materialize every historical transcript/manifest merely to render toolbar capabilities.
  const checkpoints = db
    .prepare(
      `SELECT id, kind, message_id AS messageId, step_id AS stepId,
    mutation_cursor AS mutationCursor, NULL AS reason,
    json_extract(payload_json,'$.version') = 2 AND json_type(payload_json,'$.boundary') IS NOT NULL AS available,
    COALESCE(json_extract(payload_json,'$.boundary.messageCount'),0) = 0 AS initialInput
    FROM conversation_checkpoints WHERE session_id=? ORDER BY ordinal`,
    )
    .all(sessionId) as Array<{
    id: string;
    kind: "input" | "reply";
    messageId: string;
    stepId: string | null;
    mutationCursor: number;
    reason: string | null;
    available: number;
    initialInput: number;
  }>;
  const messages = db
    .prepare(
      "SELECT id FROM agent_runtime_messages WHERE session_id=? ORDER BY sequence,created_at,rowid",
    )
    .all(sessionId) as { id: string }[];
  const messageIds = new Set(messages.map((m) => m.id));
  const latestMutation = (
    db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_mutations WHERE owner_session_id=? AND state<>'reverted'",
      )
      .get(rootOwner(sessionId)) as { cursor: number }
  ).cursor;
  return {
    revision: historyRevision(sessionId),
    recoveryRequired: Boolean(
      getRawSqlite()
        .prepare(
          "SELECT id FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing')",
        )
        .get(sessionId),
    ),
    reason,
    checkpoints: checkpoints
      .filter((c) => c.messageId && messageIds.has(c.messageId))
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        messageId: c.messageId,
        stepId: c.stepId,
        available: !c.reason && Boolean(c.available),
        reason: c.reason,
        hasLaterHistory:
          c.kind === "input" ||
          messages.at(-1)?.id !== c.messageId ||
          latestMutation > c.mutationCursor,
        initialInput: c.kind === "input" && Boolean(c.initialInput),
      })),
    sessionId: session.id,
  };
}

export async function previewHistory(
  sessionId: string,
  checkpointId: string,
  includeFiles = true,
): Promise<HistoryPreview> {
  if (versionedSession(sessionId)) {
    supported(sessionId);
    assertVersionTranscriptOperation(sessionId, includeFiles);
    assertHistoryUnlocked(sessionId, []);
    assertHistoryIdle(sessionId);
    const plan = includeFiles
      ? await planFileUndo(getCheckpoint(sessionId, checkpointId), true)
      : { changes: [], conflicts: [], warnings: [], preservedFiles: [] };
    return {
      checkpointId,
      ...versionRepository().preview(sessionId, checkpointId),
      files: plan.changes.map((c) => ({
        root: c.root,
        path: c.path,
        action: c.before ? ("restore" as const) : ("delete" as const),
      })),
      conflicts: plan.conflicts,
      canApply: plan.conflicts.length === 0,
      warnings: plan.warnings,
      preservedFiles: plan.preservedFiles,
      exclusions: SNAPSHOT_EXCLUSIONS,
    };
  }
  supported(sessionId);
  assertHistoryUnlocked(sessionId, []);
  assertHistoryIdle(sessionId);
  const checkpoint = getCheckpoint(sessionId, checkpointId);
  assertCheckpoint(checkpoint);
  const plan = await planFileUndo(checkpoint, includeFiles);
  const count = (
    getRawSqlite()
      .prepare(
        "SELECT count(*) AS count FROM agent_runtime_messages WHERE session_id=?",
      )
      .get(sessionId) as { count: number }
  ).count;
  return {
    checkpointId,
    revision: historyRevision(sessionId),
    removedMessages: Math.max(
      0,
      count - checkpoint.payload.boundary.messageCount,
    ),
    files: plan.changes.map((c) => ({
      root: c.root,
      path: c.path,
      action: c.before ? "restore" : "delete",
    })),
    conflicts: plan.conflicts,
    canApply: !plan.conflicts.length,
    warnings: plan.warnings,
    preservedFiles: plan.preservedFiles,
    exclusions: SNAPSHOT_EXCLUSIONS,
  };
}

/** Compensate only known before/after versions; never overwrite intervening edits. */
export async function recoverHistoryOperation(
  sessionId: string,
  internal = false,
): Promise<void> {
  const db = getRawSqlite();
  recoverOrphanedCheckpointWriters();
  const operation = db
    .prepare(
      `SELECT id,state,CASE WHEN length(CAST(payload_json AS BLOB))<=${FILE_JOURNAL_BYTES} THEN payload_json ELSE NULL END AS payload_json FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing') ORDER BY created_at LIMIT 1`,
    )
    .get(sessionId) as
    | { id: string; state: string; payload_json: string }
    | undefined;
  if (!operation) return;
  if (operation.payload_json === null)
    throw historyError(
      "Recovery metadata exceeds its bounded parser budget; explicit migration/recovery is required.",
      "HISTORY_PLAN_LIMIT",
    );
  const rawPayload = JSON.parse(operation.payload_json);
  if (rawPayload.kind === "simple-fork") {
    const { recoverSimpleFork } = await import("./simple-fork.js");
    await recoverSimpleFork(operation.id, internal);
    return;
  }
  if (rawPayload.kind === "fork") {
    await recoverForkOperation(operation.id, internal);
    return;
  }
  const payload = rawPayload as JournalPayload;
  if (!internal) {
    if (activeOperations.has(operation.id))
      throw historyError("History operation is still running.");
    if (
      operation.state !== "recovery_required" &&
      payload.ownerPid &&
      payload.ownerPid !== process.pid
    ) {
      let alive = true;
      try {
        process.kill(payload.ownerPid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive)
        throw historyError("History operation is owned by a live process.");
    }
  }
  if (!internal) {
    payload.ownerPid = process.pid;
    const claim = { ...payload, recoveryClaim: randomUUID() };
    const updated = db
      .prepare(
        "UPDATE conversation_history_operations SET state='applying',payload_json=? WHERE id=? AND state=? AND payload_json=?",
      )
      .run(
        JSON.stringify(claim),
        operation.id,
        operation.state,
        operation.payload_json,
      );
    if (Number(updated.changes) !== 1)
      throw historyError("Another process claimed this recovery.");
    activeOperations.add(operation.id);
  }
  try {
    const touched =
      operation.state === "prepared"
        ? []
        : payload.changes.slice(0, payload.applied + 1);
    for (const change of [...touched].reverse()) {
      const current = await checkpointFiles.version(change.root, change.path);
      if (sameVersion(current, change.after)) continue;
      if (!sameVersion(current, change.before))
        throw historyError(
          `Recovery conflict: ${change.path}. Resolve the file before retrying recovery.`,
          "HISTORY_RECOVERY_REQUIRED",
        );
      await checkpointFiles.write(change.root, change.path, change.after);
    }
    db.transaction(() => {
      writeJournal(operation.id, "aborted", payload);
      releaseHistoryLocks(operation.id);
    })();
  } catch (error) {
    writeJournal(operation.id, "recovery_required", payload);
    throw error;
  } finally {
    if (!internal) activeOperations.delete(operation.id);
  }
}

export async function applyHistory(
  sessionId: string,
  request: HistoryRequest,
): Promise<HistoryResult> {
  if (versionedSession(sessionId)) {
    supported(sessionId);
    assertVersionTranscriptOperation(
      sessionId,
      request.includeFiles !== false,
      request.action,
    );
    const { result, applied } =
      request.includeFiles !== false
        ? await applyVersionFileHistory(sessionId, request)
        : applyVersionHistory(sessionId, request);
    if (!applied) return result;
    clearSessionFileReads(sessionId);
    sessionLiveBus.clearBuffer(sessionId);
    invalidateSessionEnvironment(sessionId);
    emitRuntimeBusEvent({
      type: "session_changed",
      sessionId,
      patch: { historyRevision: result.revision, historyReset: true },
    });
    return result;
  }
  supported(sessionId);
  const db = getRawSqlite(),
    id = operationId(sessionId, request.requestId);
  const requestHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const previous = db
    .prepare(
      "SELECT request_hash,state,result_json FROM conversation_history_operations WHERE id=?",
    )
    .get(id) as
    | { request_hash: string; state: string; result_json: string | null }
    | undefined;
  if (previous) {
    if (previous.request_hash !== requestHash)
      throw historyError("Request ID was already used for different input.");
    if (previous.state === "committed")
      return JSON.parse(previous.result_json!) as HistoryResult;
    throw historyError(
      "This operation did not complete. Recover it before retrying with a new request ID.",
      "HISTORY_RECOVERY_REQUIRED",
    );
  }
  if (historyRevision(sessionId) !== request.revision)
    throw historyError(
      "Conversation changed. Refresh the preview.",
      "HISTORY_STALE",
    );
  const checkpoint = getCheckpoint(sessionId, request.checkpointId);
  assertCheckpoint(checkpoint);
  if ((request.action === "edit") !== (checkpoint.kind === "input"))
    throw historyError("Wrong checkpoint boundary for this operation.");
  if (request.action === "edit" && !request.message?.trim())
    throw historyError("The edited message cannot be empty.");
  const original = checkpoint.messageId
    ? agentRuntimeStore.getMessage(sessionId, checkpoint.messageId)
    : undefined;
  if (!original && request.action === "edit")
    throw historyError("The checkpoint message no longer exists.");
  const initialPlan = await planFileUndo(
    checkpoint,
    request.includeFiles !== false,
  );
  const roots = [...new Set(initialPlan.changes.map((c) => c.root))];
  let journal: JournalPayload = {
    changes: [],
    applied: 0,
    ownerPid: process.pid,
    request,
  };
  db.transaction(() => {
    acquireHistoryLocks(sessionId, id, roots);
    db.prepare(
      "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES (?,?,?,'prepared',?,?)",
    ).run(
      id,
      sessionId,
      requestHash,
      JSON.stringify(journal),
      new Date().toISOString(),
    );
  })();
  activeOperations.add(id);
  const originalTree = agentRuntimeStore
    .listSessionTree(sessionId)
    .map((s) => s.id);
  try {
    if (historyRevision(sessionId) !== request.revision)
      throw historyError(
        "Conversation changed. Refresh the preview.",
        "HISTORY_STALE",
      );
    const { changes, conflicts } = await planFileUndo(
      checkpoint,
      request.includeFiles !== false,
    );
    if (conflicts.length)
      throw historyError(
        `File conflicts: ${conflicts.map((c) => c.path).join(", ")}`,
        "HISTORY_FILE_CONFLICT",
      );
    journal = { ...journal, changes };
    writeJournal(id, "prepared", journal);
    for (const change of changes) {
      if (await committedFileReason(change))
        throw historyError(
          "Git commit status changed. Refresh the preview; committed files will be preserved.",
          "HISTORY_GIT_CHANGED",
        );
      // Validate each file again immediately before mutation; journal + compensation handles late conflicts.
      if (
        !sameVersion(
          await checkpointFiles.version(change.root, change.path),
          change.after,
        )
      )
        throw historyError(
          `File changed: ${change.path}`,
          "HISTORY_FILE_CONFLICT",
        );
      writeJournal(id, "applying", journal);
      await checkpointFiles.write(change.root, change.path, change.before);
      journal.applied++;
      writeJournal(id, "applying", journal);
    }
    let result: HistoryResult = { sessionId, revision: request.revision + 1 };
    db.transaction(() => {
      restoreHistoryBoundary(sessionId, checkpoint.payload.boundary);
      db.prepare(
        "DELETE FROM conversation_checkpoints WHERE session_id=? AND ordinal>?",
      ).run(
        sessionId,
        checkpoint.ordinal - (request.action === "edit" ? 1 : 0),
      );
      db.prepare(
        "UPDATE conversation_mutations SET state='reverted',changes_json='[]' WHERE owner_session_id=? AND sequence>?",
      ).run(rootOwner(sessionId), checkpoint.mutationCursor);
      db.prepare(
        "INSERT INTO conversation_history_versions(session_id,revision) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision",
      ).run(sessionId, result.revision);
      agentRuntimeStore.updateSessionMetadata(sessionId, {
        historyRevision: result.revision,
      });
      // Admission below is in this same transaction; no competing run can slip between restore and enqueue.
      writeJournal(id, "committed", journal!);
      releaseHistoryLocks(id);
      if (request.action === "edit") {
        if (checkpoint.payload.boundary.messageCount === 0) {
          const session = agentRuntimeStore.getSession(sessionId);
          agentRuntimeStore.updateSession(sessionId, {
            prompt: request.message!.trim(),
            sessionMetadata: {
              ...session.sessionMetadata,
              userPrompt: request.message!.trim(),
              goalContent: request.message!.trim(),
              ...(session.sessionMetadata?.goal
                ? { goal: initializeGoal(request.message!.trim()) }
                : {}),
            },
          });
        }
        const input: StreamTurnRequest = {
          message: request.message!.trim(),
          contentParts: original!.contentParts,
          references: original!.metadata
            ?.references as StreamTurnRequest["references"],
        };
        // Text content parts must not resurrect the old message body.
        if (input.contentParts)
          input.contentParts = [
            { type: "text", text: request.message!.trim() },
            ...input.contentParts.filter((p) => p.type !== "text"),
          ];
        const accepted = acceptRuntimeRun(sessionId, input, id, "turn");
        result = { ...result, runId: accepted.run.id, input };
      }
      db.prepare(
        "UPDATE conversation_history_operations SET result_json=? WHERE id=?",
      ).run(JSON.stringify(result), id);
    })();
    for (const id of originalTree) clearSessionFileReads(id);
    const restoredIds = new Set(
      agentRuntimeStore.listSessionTree(sessionId).map((row) => row.id),
    );
    for (const childId of originalTree.filter((id) => id !== sessionId)) {
      sessionLiveBus.clearBuffer(childId);
      emitRuntimeBusEvent(
        restoredIds.has(childId)
          ? {
              type: "session_changed",
              sessionId: childId,
              patch: { historyReset: true },
            }
          : { type: "session_deleted", sessionId: childId },
      );
    }
    sessionLiveBus.clearBuffer(sessionId);
    invalidateSessionEnvironment(sessionId);
    emitRuntimeBusEvent({
      type: "session_changed",
      sessionId,
      patch: { historyRevision: result.revision, historyReset: true },
    });
    return result;
  } catch (error) {
    if (journal) await recoverHistoryOperation(sessionId, true);
    else releaseHistoryLocks(id);
    throw error;
  } finally {
    activeOperations.delete(id);
  }
}
export function editRunRequestId(sessionId: string, requestId: string): string {
  return operationId(sessionId, requestId);
}
