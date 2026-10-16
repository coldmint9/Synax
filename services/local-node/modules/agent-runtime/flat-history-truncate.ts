import { migrateFlatHistory } from "./flat-history-migration.js";
import { simpleHistorySession } from "./simple-history.js";
import { createHash } from "node:crypto";
import { getRawSqlite } from "../../infrastructure/database/index.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  assertHistoryIdle,
  assertHistoryUnlocked,
  historyError,
} from "./checkpoints/guards.js";
import {
  simpleHistoryBoundary,
  simpleHistoryRevision,
  bumpSimpleHistoryRevision,
  removedMessageCount,
} from "./simple-history.js";
import type {
  HistoryRequest,
  HistoryResult,
} from "./checkpoints/operations.js";
import { acceptRuntimeRun } from "./run-admission.js";
import { initializeGoal } from "./goal-control.js";
import { clearSessionFileReads } from "./read-tracker.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { invalidateSessionEnvironment } from "./session-environment.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";

export function applyFlatHistory(
  sessionId: string,
  request: HistoryRequest,
): HistoryResult {
  if (request.includeFiles === true)
    throw historyError(
      "Conversation trimming cannot restore workspace files.",
      "HISTORY_FILES_UNAVAILABLE",
    );
  const db = getRawSqlite();
  const requestHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  let changed = false;
  const removedChildren: string[] = [];
  const result = db.transaction(() => {
    const session = agentRuntimeStore.getSession(sessionId);
    if (
      session.parentSessionId ||
      session.sessionMetadata?.historyRollbackEnabled === false ||
      ((session.sessionMetadata?.backend as { id?: string })?.id ??
        "native") !== "native"
    )
      throw historyError(
        "Conversation trimming requires a supported root session.",
        "HISTORY_UNSUPPORTED",
      );
    const prior = db
      .prepare(
        "SELECT last_request_id,last_request_hash,last_result_json FROM conversation_flat_heads WHERE session_id=?",
      )
      .get(sessionId) as {
      last_request_id: string | null;
      last_request_hash: string | null;
      last_result_json: string | null;
    };
    if (prior.last_request_id === request.requestId) {
      if (prior.last_request_hash !== requestHash)
        throw historyError("Request ID was already used for different input.");
      const result = JSON.parse(prior.last_result_json!) as HistoryResult;
      if (result.runId) {
        const run = agentRuntimeStore.getRun(result.runId);
        const runtime = run.metadata.runtime as
          | { input?: import("./contracts.js").StreamTurnRequest }
          | undefined;
        return { ...result, input: runtime?.input };
      }
      return result;
    }
    assertHistoryUnlocked(sessionId, []);
    assertHistoryIdle(sessionId);
    if (
      db
        .prepare(
          "SELECT 1 FROM media_jobs WHERE session_id=? AND status IN ('queued','submitting','running','downloading','unknown') LIMIT 1",
        )
        .get(sessionId)
    )
      throw historyError(
        "Finish or cancel pending media jobs before trimming.",
        "HISTORY_SESSION_BUSY",
      );
    if (
      db
        .prepare(
          "SELECT 1 FROM artifact_jobs WHERE session_id=? AND status IN ('queued','building') LIMIT 1",
        )
        .get(sessionId) ||
      db
        .prepare(
          "SELECT 1 FROM agent_artifact_builds WHERE session_id=? AND status='building' LIMIT 1",
        )
        .get(sessionId)
    )
      throw historyError(
        "Finish or cancel pending artifact builds before trimming.",
        "HISTORY_SESSION_BUSY",
      );
    if (simpleHistoryRevision(sessionId) !== request.revision)
      throw historyError(
        "Conversation changed. Refresh the preview.",
        "HISTORY_STALE",
      );
    const point = simpleHistoryBoundary(sessionId, request.checkpointId);
    if ((request.action === "edit") !== (point.kind === "input"))
      throw historyError("Wrong boundary for this action.");
    if (request.action === "edit" && !request.message?.trim())
      throw historyError("The edited message cannot be empty.");
    const original = agentRuntimeStore.getMessage(sessionId, point.messageId)!;
    const cutoff = point.sequence - (point.kind === "input" ? 1 : 0);
    if (!removedMessageCount(sessionId, point))
      throw historyError("There are no later messages to remove.");
    // Derived child executions are invalidated as a unit. They must not feed
    // results from the discarded future back into the next model context.
    for (const child of agentRuntimeStore
      .listSessionTree(sessionId)
      .filter((item) => item.id !== sessionId))
      if (!simpleHistorySession(child.id)) migrateFlatHistory(child.id);
    for (const child of agentRuntimeStore
      .listSessionTree(sessionId)
      .filter((item) => item.parentSessionId === sessionId))
      removedChildren.push(...agentRuntimeStore.deleteSessionTree(child.id));
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS flat_removed_runs(id TEXT PRIMARY KEY); DELETE FROM flat_removed_runs;
      CREATE TEMP TABLE IF NOT EXISTS flat_removed_steps(id TEXT PRIMARY KEY); DELETE FROM flat_removed_steps;`);
    db.prepare(
      `INSERT INTO flat_removed_runs SELECT r.id FROM agent_runtime_runs r WHERE r.session_id=? AND
      (r.started_at>? OR EXISTS(SELECT 1 FROM agent_runtime_messages m WHERE m.session_id=r.session_id AND m.sequence>? AND (m.run_id=r.id OR m.id=r.trigger_message_id)))
      AND NOT EXISTS(SELECT 1 FROM agent_runtime_messages m WHERE m.session_id=r.session_id AND m.sequence<=? AND m.run_id=r.id)`,
    ).run(sessionId, point.createdAt, cutoff, cutoff);
    db.prepare(
      `INSERT INTO flat_removed_steps SELECT s.id FROM agent_runtime_run_steps s WHERE s.session_id=? AND
      (s.run_id IN (SELECT id FROM flat_removed_runs) OR s.started_at>? OR EXISTS(SELECT 1 FROM agent_runtime_messages m WHERE m.session_id=s.session_id AND m.sequence>? AND m.step_id=s.id))
      AND NOT EXISTS(SELECT 1 FROM agent_runtime_messages m WHERE m.session_id=s.session_id AND m.sequence<=? AND m.step_id=s.id)`,
    ).run(sessionId, point.createdAt, cutoff, cutoff);
    for (const table of [
      "agent_runtime_run_parts",
      "agent_runtime_tool_calls",
      "agent_runtime_permissions",
      "agent_runtime_interactions",
    ]) {
      const time =
        table === "agent_runtime_tool_calls" ? "started_at" : "created_at";
      db.prepare(
        `DELETE FROM ${table} WHERE session_id=? AND (run_id IN (SELECT id FROM flat_removed_runs) OR step_id IN (SELECT id FROM flat_removed_steps) OR ${time}>?)`,
      ).run(sessionId, point.createdAt);
    }
    db.prepare(
      "DELETE FROM agent_runtime_run_steps WHERE session_id=? AND id IN (SELECT id FROM flat_removed_steps)",
    ).run(sessionId);
    db.prepare(
      "DELETE FROM agent_runtime_runs WHERE session_id=? AND id IN (SELECT id FROM flat_removed_runs)",
    ).run(sessionId);
    // Close every surviving execution lease as well; a stopped worker can never
    // re-open a completed run by writing a delayed result after truncation.
    db.prepare(
      "UPDATE agent_runtime_runs SET metadata_json=json_set(metadata_json,'$.executionLease.closed',json('true')) WHERE session_id=? AND json_type(metadata_json,'$.executionLease')='object'",
    ).run(sessionId);
    db.prepare(
      "DELETE FROM agent_runtime_messages WHERE session_id=? AND sequence>?",
    ).run(sessionId, cutoff);
    db.prepare(
      "DELETE FROM agent_runtime_events WHERE session_id=? AND timestamp>=?",
    ).run(sessionId, point.createdAt);
    db.prepare(
      "DELETE FROM agent_runtime_artifacts WHERE session_id=? AND created_at>?",
    ).run(sessionId, point.createdAt);
    db.prepare(
      "DELETE FROM media_jobs WHERE session_id=? AND created_at>?",
    ).run(sessionId, point.createdAt);
    // Summaries/plans are derived from mutable execution progress and cannot be
    // reused after a destructive prefix operation. Rebuild on the next turn.
    for (const table of [
      "agent_runtime_context_bundles",
      "agent_runtime_compaction_summaries",
      "agent_runtime_thinking_summaries",
      "agent_runtime_work",
      "agent_plan_artifacts",
      "conversation_checkpoints",
      "conversation_history_journal",
      "conversation_history_tracking",
    ])
      db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
    db.prepare(
      "UPDATE agent_runtime_interactions SET consumed_at=COALESCE(consumed_at,?) WHERE session_id=?",
    ).run(new Date().toISOString(), sessionId);
    db.prepare(
      "DELETE FROM agent_runtime_aux_usage WHERE session_id=? AND (started_at>? OR run_id IN (SELECT id FROM flat_removed_runs))",
    ).run(sessionId, point.createdAt);
    const metadata = { ...session.sessionMetadata };
    for (const key of [
      "plan",
      "goal",
      "runtimeControl",
      "inputQueue",
      "inputForceInjectId",
      "pendingResume",
      "turnReferences",
      "latestSystemPrompt",
      "contextCompaction",
      "contextComposition",
      "recovery",
      "executionLease",
      "contextMemorySegment",
      "contextMemory",
      "contextEpoch",
      "activeWorkId",
      "fileReadHistoryBoundary",
    ])
      delete metadata[key];
    if (metadata.mode === "goal")
      metadata.goal = initializeGoal(
        request.action === "edit" && cutoff === 0
          ? request.message!.trim()
          : session.prompt,
      );
    const revision = bumpSimpleHistoryRevision(sessionId);
    metadata.historyRevision = revision;
    metadata.fileReadAfterRowid = (
      db
        .prepare(
          "SELECT COALESCE(MAX(rowid),0) AS n FROM agent_runtime_tool_calls WHERE session_id=?",
        )
        .get(sessionId) as { n: number }
    ).n;
    db.prepare(
      "UPDATE agent_runtime_run_steps SET metadata_json=json_remove(metadata_json,'$.contextMemorySegment','$.contextMemorySourceFingerprint','$.contextCompaction','$.runtimeReminder','$.protocol','$.providerMetadata') WHERE session_id=?",
    ).run(sessionId);
    const prompt =
      request.action === "edit" && cutoff === 0
        ? request.message!.trim()
        : session.prompt;
    if (cutoff === 0) {
      metadata.userPrompt = prompt;
      metadata.goalContent = prompt;
    }
    agentRuntimeStore.updateSession(sessionId, {
      prompt,
      sessionMetadata: metadata,
      childSessionIds: [],
      activeRunId: null,
      pendingResumeToken: null,
      contextSnapshotId: null,
      resultSummary: null,
      blockedReason: null,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    db.prepare(
      "UPDATE conversation_flat_heads SET epoch=epoch+1 WHERE session_id=?",
    ).run(sessionId);
    let outcome: HistoryResult = { sessionId, revision };
    if (request.action === "edit") {
      const input = {
        message: request.message!.trim(),
        contentParts: original.contentParts
          ? [
              { type: "text" as const, text: request.message!.trim() },
              ...original.contentParts.filter((part) => part.type !== "text"),
            ]
          : undefined,
        references: original.metadata
          .references as import("./contracts.js").StreamTurnRequest["references"],
      };
      const id = `history_${createHash("sha256").update(`${sessionId}:${request.requestId}`).digest("hex")}`;
      const accepted = acceptRuntimeRun(sessionId, input, id, "turn");
      outcome = { ...outcome, runId: accepted.run.id, input };
    }
    // Keep only one content-free retry receipt. Never retain the removed messages
    // or the edited prompt in an operation journal.
    db.prepare(
      "UPDATE conversation_flat_heads SET last_request_id=?,last_request_hash=?,last_result_json=? WHERE session_id=?",
    ).run(
      request.requestId,
      requestHash,
      JSON.stringify({ sessionId, revision, runId: outcome.runId }),
      sessionId,
    );
    db.exec("DELETE FROM flat_removed_runs; DELETE FROM flat_removed_steps;");
    changed = true;
    return outcome;
  })();
  if (changed) {
    clearSessionFileReads(sessionId);
    sessionLiveBus.clearBuffer(sessionId);
    invalidateSessionEnvironment(sessionId);
    for (const id of removedChildren) sessionLiveBus.cleanup(id);
    emitRuntimeBusEvent({
      type: "session_changed",
      sessionId,
      patch: { historyRevision: result.revision, historyReset: true },
    });
  }
  return result;
}
