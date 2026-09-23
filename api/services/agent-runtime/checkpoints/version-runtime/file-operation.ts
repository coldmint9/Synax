import { createHash } from "node:crypto";
import { getRawSqlite } from "../../../../db/index.js";
import type { HistoryRequest, HistoryResult } from "../operations.js";
import { recoverHistoryOperation } from "../operations.js";
import { planFileUndo } from "../file-plan.js";
import { checkpointFiles, sameVersion } from "../files.js";
import { committedFileReason } from "../git-boundary.js";
import {
  acquireHistoryLocks,
  releaseHistoryLocks,
  historyError,
  activeHistoryOperations,
  assertHistoryIdle,
  assertHistoryUnlocked,
} from "../guards.js";
import { writeFileJournal, type JournalPayload } from "../file-journal.js";
import { versionRepository } from "./bridge.js";
import { VersionHistoryResults } from "./history-results.js";
import {
  applyVersionHistory,
  versionHistoryRequestHash,
} from "./history-operation.js";

/** A bounded compensation journal protects real files before the immutable head
 * moves. The existing recovery endpoint can recover this operation after a crash. */
export async function applyVersionFileHistory(
  sessionId: string,
  request: HistoryRequest,
): Promise<{ result: HistoryResult; applied: boolean }> {
  const db = getRawSqlite(),
    repo = versionRepository(),
    hash = versionHistoryRequestHash(request),
    cache = new VersionHistoryResults(db);
  const previous = cache.read<HistoryResult>(
    sessionId,
    request.requestId,
    hash,
  );
  if (previous) return { result: previous, applied: false };
  const id = `history_${createHash("sha256").update(`${sessionId}:${request.requestId}`).digest("hex")}`;
  const prior = db
    .prepare(
      "SELECT request_hash,state FROM conversation_history_operations WHERE id=?",
    )
    .get(id) as { request_hash: string; state: string } | undefined;
  if (prior)
    throw historyError(
      prior.request_hash === hash
        ? "This operation did not complete. Recover it and retry with a new request ID."
        : "Request identity was used for different input.",
      "HISTORY_RECOVERY_REQUIRED",
    );
  assertHistoryUnlocked(sessionId);
  assertHistoryIdle(sessionId);
  if (repo.head(sessionId).revision !== request.revision)
    throw historyError(
      "Conversation revision changed; refresh the preview.",
      "HISTORY_STALE",
    );
  const checkpoint = repo.checkpoint(sessionId, request.checkpointId),
    initial = await planFileUndo(checkpoint, true);
  if (initial.conflicts.length)
    throw historyError(
      "File conflicts must be resolved before restoring history.",
      "HISTORY_FILE_CONFLICT",
    );
  const roots = [...new Set(initial.changes.map((change) => change.root))];
  let payload: JournalPayload = {
    changes: [],
    applied: 0,
    ownerPid: process.pid,
    request,
  };
  db.transaction(() => {
    if (repo.head(sessionId).revision !== request.revision)
      throw historyError("Conversation revision changed.", "HISTORY_STALE");
    acquireHistoryLocks(sessionId, id, roots);
    db.prepare(
      "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES(?,?,?,'prepared',?,?)",
    ).run(
      id,
      sessionId,
      hash,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  })();
  activeHistoryOperations.add(id);
  try {
    const plan = await planFileUndo(checkpoint, true);
    if (plan.conflicts.length)
      throw historyError(
        "File conflicts changed after acquiring the restore fence.",
        "HISTORY_FILE_CONFLICT",
      );
    if (plan.changes.some((change) => !roots.includes(change.root)))
      throw historyError(
        "File restore roots changed; refresh the preview.",
        "HISTORY_FILE_CONFLICT",
      );
    payload = { ...payload, changes: plan.changes };
    writeFileJournal(id, "prepared", payload);
    for (const change of plan.changes) {
      if (await committedFileReason(change))
        throw historyError(
          "Git commit state changed. Refresh the file preview.",
          "HISTORY_GIT_CHANGED",
        );
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
      writeFileJournal(id, "applying", payload);
      await checkpointFiles.write(change.root, change.path, change.before);
      payload.applied++;
      writeFileJournal(id, "applying", payload);
    }
    return db.transaction(() => {
      // Changes are invisible to other connections until this transaction commits.
      // Releasing our own journal/locks here lets the ordinary admission checks run;
      // any failure rolls this transition back before compensating the files.
      if (repo.head(sessionId).revision !== request.revision)
        throw historyError(
          "Conversation revision changed during file restore.",
          "HISTORY_STALE",
        );
      writeFileJournal(id, "committed", payload);
      releaseHistoryLocks(id);
      const outcome = applyVersionHistory(sessionId, request);
      db.prepare(
        "UPDATE conversation_history_operations SET result_json=?,payload_json='{}' WHERE id=?",
      ).run(JSON.stringify(outcome.result), id);
      return outcome;
    })();
  } catch (error) {
    await recoverHistoryOperation(sessionId, true);
    throw error;
  } finally {
    activeHistoryOperations.delete(id);
  }
}
