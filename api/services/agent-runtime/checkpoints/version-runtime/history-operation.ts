import { createHash } from "node:crypto";
import { getRawSqlite } from "../../../../db/index.js";
import { agentRuntimeStore as store } from "../../session-store.js";
import { acceptRuntimeRun } from "../../run-admission.js";
import { initializeGoal } from "../../goal-control.js";
import type { StreamTurnRequest } from "../../contracts.js";
import type { HistoryRequest, HistoryResult } from "../operations.js";
import {
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyError,
} from "../guards.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import { versionRepository } from "./bridge.js";
import { VersionHistoryResults } from "./history-results.js";
import { assertBatchInput } from "./batch-input.js";

/** No file writes here. Restore, input adjustment, admission and the final retry
 * result are atomic; execution is launched only by the caller after commit. */
export function applyVersionHistory(
  sessionId: string,
  request: HistoryRequest,
): { result: HistoryResult; applied: boolean } {
  assertBatchInput(request);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        checkpointId: request.checkpointId,
        revision: request.revision,
        action: request.action,
        message: request.message,
        includeFiles: request.includeFiles !== false,
      }),
    )
    .digest("hex");
  const db = getRawSqlite(),
    cache = new VersionHistoryResults(db),
    repo = versionRepository();
  return atomicVersionWrite(db, () => {
    const previous = cache.read<HistoryResult>(
      sessionId,
      request.requestId,
      hash,
    );
    if (previous) return { result: previous, applied: false };
    assertHistoryUnlocked(sessionId, []);
    assertHistoryIdle(sessionId);
    const checkpoint = repo.checkpoint(sessionId, request.checkpointId);
    const edit = request.action === "edit";
    if ((checkpoint.kind === "input") !== edit)
      throw historyError("Wrong checkpoint boundary for this history action.");
    if (edit && (!request.message?.trim() || request.message.length > 100000))
      throw historyError("Edited message must contain 1–100000 characters.");
    const original = edit
      ? store.getMessage(sessionId, checkpoint.messageId)
      : undefined;
    if (edit && !original)
      throw historyError("The original input message no longer exists.");
    if (original?.contentParts?.some((part) => part.type !== "text"))
      throw historyError(
        "Versioned edit of attached assets is not integrated yet.",
        "VERSION_RUNTIME_NOT_READY",
      );
    repo.rollback(sessionId, { ...request, requestHash: hash });
    if (edit && checkpoint.payload.boundary.omitRunId)
      repo.remove(sessionId, "runs", checkpoint.payload.boundary.omitRunId);
    const restored = store.getSession(sessionId),
      metadata = { ...restored.sessionMetadata };
    for (const key of [
      "runtimeControl",
      "manualStop",
      "inputQueue",
      "inputForceInjectId",
      "pendingResume",
      "turnReferences",
    ])
      delete metadata[key];
    if (edit && checkpoint.payload.boundary.messageCount === 0) {
      metadata.userPrompt = request.message!.trim();
      metadata.goalContent = request.message!.trim();
      if (metadata.goal)
        metadata.goal = initializeGoal(request.message!.trim());
    }
    store.updateSession(sessionId, {
      status: "completed",
      activeRunId: null,
      pendingResumeToken: null,
      blockedReason: null,
      sessionMetadata: metadata,
      ...(edit && checkpoint.payload.boundary.messageCount === 0
        ? { prompt: request.message!.trim() }
        : {}),
    });
    let result: HistoryResult = {
      sessionId,
      revision: repo.head(sessionId).revision,
    };
    if (edit) {
      const input: StreamTurnRequest = {
        message: request.message!.trim(),
        contentParts: original!.contentParts
          ? [{ type: "text", text: request.message!.trim() }]
          : undefined,
        references: original!.metadata
          .references as StreamTurnRequest["references"],
      };
      const operationId = `history_${createHash("sha256").update(`${sessionId}:${request.requestId}`).digest("hex")}`;
      const accepted = acceptRuntimeRun(sessionId, input, operationId, "turn");
      result = {
        sessionId,
        revision: repo.head(sessionId).revision,
        runId: accepted.run.id,
        input,
      };
    }
    cache.save(sessionId, request.requestId, hash, result);
    return { result, applied: true };
  });
}
