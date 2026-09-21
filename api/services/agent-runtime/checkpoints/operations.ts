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
import { replaceHistory } from "./state.js";

export interface HistoryRequest {
  checkpointId: string;
  revision: number;
  requestId: string;
  action: "rollback" | "edit";
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
interface JournalPayload {
  changes: FileChange[];
  ownerPid: number;
  applied: number;
  request: HistoryRequest;
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
  if (
    checkpoint.payload.error ||
    !checkpoint.payload.history ||
    !checkpoint.payload.manifests?.length
  )
    throw historyError(
      checkpoint.payload.error ||
        "No complete historical snapshot is available.",
      "CHECKPOINT_UNAVAILABLE",
    );
}

export function checkpointSummary(sessionId: string) {
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
    mutation_cursor AS mutationCursor, json_extract(payload_json,'$.error') AS reason,
    json_type(payload_json,'$.history') IS NOT NULL AND json_array_length(payload_json,'$.manifests') > 0 AS available,
    COALESCE(json_array_length(payload_json,'$.history.tables.agent_runtime_messages'),0) = 0 AS initialInput
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

async function prepareChanges(
  checkpoint: ConversationCheckpoint,
): Promise<{ changes: FileChange[]; conflicts: FileConflict[] }> {
  const db = getRawSqlite(),
    owner = rootOwner(checkpoint.sessionId),
    conflicts: FileConflict[] = [];
  const mutations = db
    .prepare(
      "SELECT * FROM conversation_mutations WHERE sequence>? ORDER BY sequence",
    )
    .all(checkpoint.mutationCursor) as Mutation[];
  const ours = mutations.filter(
    (m) => m.owner_session_id === owner && m.state !== "reverted",
  );
  const byPath = new Map<string, FileChange>();
  for (const mutation of ours) {
    if (mutation.uncertain || mutation.state === "open") {
      for (const root of JSON.parse(mutation.roots_json) as string[])
        conflicts.push({
          root,
          path: "*",
          reason:
            "Overlapping, incomplete or background writes cannot be safely attributed.",
        });
    }
    for (const change of JSON.parse(mutation.changes_json) as FileChange[]) {
      const key = JSON.stringify([change.root, change.path]),
        previous = byPath.get(key);
      if (previous && !sameVersion(previous.after, change.before))
        conflicts.push({
          root: change.root,
          path: change.path,
          reason: "Independent changes occurred between these writes.",
        });
      byPath.set(key, previous ? { ...previous, after: change.after } : change);
    }
  }
  const changes = [...byPath.values()].filter(
    (c) => !sameVersion(c.before, c.after),
  );
  // Same-content subsequent writes from another session still have independent ownership.
  for (const mutation of mutations.filter(
    (m) => m.owner_session_id !== owner && m.state !== "reverted",
  )) {
    for (const other of JSON.parse(mutation.changes_json) as FileChange[])
      if (changes.some((c) => c.root === other.root && c.path === other.path))
        conflicts.push({
          root: other.root,
          path: other.path,
          reason: "Another session also wrote this file.",
        });
    if (
      mutation.uncertain &&
      (JSON.parse(mutation.roots_json) as string[]).some((root) =>
        changes.some((c) => rootsOverlap(root, c.root)),
      )
    )
      conflicts.push({
        root: "*",
        path: "*",
        reason: "Another session has unattributed writes in this workspace.",
      });
  }
  const roots = sessionRoots(checkpoint.sessionId);
  if (roots.length !== checkpoint.payload.manifests!.length)
    conflicts.push({
      root: "*",
      path: "*",
      reason: "Workspace bindings have changed.",
    });
  for (const manifest of checkpoint.payload.manifests!) {
    if (!roots.includes(manifest.root))
      conflicts.push({
        root: manifest.root,
        path: "*",
        reason: "Workspace binding has changed.",
      });
    else if ((await checkpointFiles.head(manifest.root)) !== manifest.gitHead)
      conflicts.push({
        root: manifest.root,
        path: "*",
        reason:
          "Git HEAD changed; Git history is not rewound by conversation rollback.",
      });
  }
  conflicts.push(...(await checkpointFiles.verify(changes, "after")));
  return { changes, conflicts };
}
export async function previewHistory(
  sessionId: string,
  checkpointId: string,
): Promise<HistoryPreview> {
  supported(sessionId);
  assertHistoryUnlocked(sessionId);
  assertHistoryIdle(sessionId);
  const checkpoint = getCheckpoint(sessionId, checkpointId);
  assertCheckpoint(checkpoint);
  const { changes, conflicts } = await prepareChanges(checkpoint);
  const beforeCount =
    checkpoint.payload.history!.tables.agent_runtime_messages.filter(
      (row) => row.session_id === sessionId,
    ).length;
  return {
    checkpointId,
    revision: historyRevision(sessionId),
    removedMessages: Math.max(
      0,
      agentRuntimeStore.listMessages(sessionId).length - beforeCount,
    ),
    files: changes.map((c) => ({
      root: c.root,
      path: c.path,
      action: c.before ? "restore" : "delete",
    })),
    conflicts,
    exclusions: SNAPSHOT_EXCLUSIONS,
    canApply: !conflicts.length,
  };
}

function writeJournal(
  id: string,
  state: string,
  payload: JournalPayload,
): void {
  getRawSqlite()
    .prepare(
      "UPDATE conversation_history_operations SET state=?,payload_json=? WHERE id=?",
    )
    .run(state, JSON.stringify(payload), id);
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
      "SELECT id,state,payload_json FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing') ORDER BY created_at LIMIT 1",
    )
    .get(sessionId) as
    | { id: string; state: string; payload_json: string }
    | undefined;
  if (!operation) return;
  const rawPayload = JSON.parse(operation.payload_json);
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
  const original = agentRuntimeStore
    .listMessages(sessionId)
    .find((m) => m.id === checkpoint.messageId);
  if (!original) throw historyError("The checkpoint message no longer exists.");
  const roots = sessionRoots(sessionId);
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
    const { changes, conflicts } = await prepareChanges(checkpoint);
    if (conflicts.length)
      throw historyError(
        `File conflicts: ${conflicts.map((c) => c.path).join(", ")}`,
        "HISTORY_FILE_CONFLICT",
      );
    journal = { ...journal, changes };
    writeJournal(id, "prepared", journal);
    for (const change of changes) {
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
      replaceHistory(sessionId, checkpoint.payload.history!);
      db.prepare(
        "DELETE FROM conversation_checkpoints WHERE session_id=? AND ordinal>?",
      ).run(
        sessionId,
        checkpoint.ordinal - (request.action === "edit" ? 1 : 0),
      );
      db.prepare(
        "UPDATE conversation_mutations SET state='reverted' WHERE owner_session_id=? AND sequence>?",
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
        if (
          !checkpoint.payload.history!.tables.agent_runtime_messages.some(
            (row) => row.session_id === sessionId,
          )
        ) {
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
          contentParts: original.contentParts,
          references: original.metadata
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
    const restoredIds = new Set(
      checkpoint.payload.history!.sessions.map((row) => String(row.id)),
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
