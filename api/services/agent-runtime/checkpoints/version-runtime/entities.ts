import { admitVersionGrowth } from "../resource-admission.js";
import { diagnosticPage, isDiagnostic, readDiagnostic, trackDiagnostic } from "./diagnostics.js";
import { retainVersionRecordAssets } from "./assets.js";
import type { RuntimeContentPart } from "../../content-parts.js";
import { assertBatchInput } from "./batch-input.js";
import { getRawSqlite } from "../../../../db/index.js";
import { AgentNotFoundError, AgentRuntimeError } from "../../runtime-errors.js";
import {
  appendOnlySession,
  boundaryOnlySession,
  versionRepository,
  versionedSession,
  versionRuntimeMode,
} from "./bridge.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import { readVersionSnapshot } from "../version-store/read-snapshot.js";

const physical: Record<string, string> = {
  interactions: "agent_runtime_interactions",
  work: "agent_runtime_work",
  runs: "agent_runtime_runs",
  steps: "agent_runtime_run_steps",
  parts: "agent_runtime_run_parts",
  tools: "agent_runtime_tool_calls",
  permissions: "agent_runtime_permissions",
  artifacts: "agent_runtime_artifacts",
  contexts: "agent_runtime_context_bundles",
  thinking: "agent_runtime_thinking_summaries",
  compactions: "agent_runtime_compaction_summaries",
};
const key = "__synaxExecutionEpoch";
function table(name: string): string {
  if (!physical[name]) throw new Error("Unsupported version entity table.");
  return physical[name];
}
export function entityScope(kind: string, id: string): string | undefined {
  const row = getRawSqlite()
    .prepare(`SELECT session_id FROM ${table(kind)} WHERE id=?`)
    .get(id) as { session_id: string | null } | undefined;
  return row?.session_id && versionedSession(row.session_id)
    ? row.session_id
    : undefined;
}
/** Publish content and its small mutable control projection atomically. Control
 * row retention is separate from immutable GC and is not yet a lifetime quota. */
export function writeVersionEntity<T>(
  sessionId: string,
  kind: string,
  id: string,
  value: T,
  writeControl: () => T,
): T {
  assertBatchInput(value);
  const db = getRawSqlite();
  return atomicVersionWrite(db, () => {
    if (versionRuntimeMode(sessionId) !== "native")
      throw new AgentRuntimeError(
        "Version transcript rollout is not ready for execution entities.",
        "VERSION_RUNTIME_NOT_READY",
        409,
      );
    const repo = versionRepository(),
      epoch = repo.head(sessionId).epoch;
    const previous = db
      .prepare(`SELECT session_id,version_epoch FROM ${table(kind)} WHERE id=?`)
      .get(id) as
      | { session_id: string; version_epoch: number | null }
      | undefined;
    if (
      previous &&
      (previous.session_id !== sessionId ||
        (previous.version_epoch !== null &&
          previous.version_epoch !== epoch &&
          kind !== "work"))
    )
      throw new AgentRuntimeError(
        "Execution entity belongs to another session or obsolete epoch.",
        "EXECUTION_SUPERSEDED",
        409,
      );
    if (boundaryOnlySession(sessionId) && (isDiagnostic(kind) || appendOnlySession(sessionId)))
      admitVersionGrowth(db, Buffer.byteLength(JSON.stringify(value)));
    const result = writeControl();
    db.prepare(
      `UPDATE ${table(kind)} SET version_epoch=? WHERE id=? AND session_id=?`,
    ).run(epoch, id, sessionId);
    if (boundaryOnlySession(sessionId) && (isDiagnostic(kind) || appendOnlySession(sessionId))) {
      trackDiagnostic(sessionId, kind, id);
      // Raw tool evidence retains its media until session deletion. It is not
      // snapshotted and cannot grant access to a discarded branch's tool input.
      const parts = (value as Record<string, unknown>).contentParts;
      if (Array.isArray(parts)) for (const part of parts) {
        if (part?.type !== "text" && typeof part?.assetId === "string")
          db.prepare("INSERT OR IGNORE INTO agent_runtime_asset_sessions(asset_id,session_id) VALUES(?,?)").run(part.assetId, sessionId);
      }
      return result;
    }
    const fields: Record<string, unknown> = {
      ...(value as Record<string, unknown>),
      [key]: epoch,
    };
    if (kind === "runs") {
      const metadata = {
        ...((fields as Record<string, unknown>).metadata as Record<
          string,
          unknown
        >),
      };
      delete metadata.executionLease;
      delete metadata.recovery;
      (fields as Record<string, unknown>).metadata = metadata;
    }
    repo.put(sessionId, kind, id, fields);
    if (Array.isArray(fields.contentParts))
      retainVersionRecordAssets(
        sessionId,
        kind,
        id,
        fields.contentParts as RuntimeContentPart[],
      );
    return result;
  });
}
const liveColumns: Record<string, string> = {
  interactions: "status,resolved_at AS resolvedAt",
  runs: "status,completed_at AS completedAt,stop_reason AS stopReason,current_step AS currentStep",
  steps: "status,completed_at AS completedAt,finish_reason AS finishReason",
  tools: "status,ended_at AS endedAt,error",
  permissions:
    "action,user_reply AS userReply,resolved_at AS resolvedAt,resume_token AS resumeToken",
};
function currentControl(
  sessionId: string,
  kind: string,
  id: string,
  epoch: number,
): Record<string, unknown> {
  if (!liveColumns[kind]) return {};
  const row = getRawSqlite()
    .prepare(
      `SELECT ${liveColumns[kind]} FROM ${table(kind)} WHERE id=? AND session_id=? AND version_epoch=?`,
    )
    .get(id, sessionId, epoch) as Record<string, unknown> | undefined;
  if (!row) return {};
  const result = { ...row };
  delete result._metadata;
  return result;
}
export function normalizeVersionEntity(
  kind: string,
  row: Record<string, unknown>,
  epoch: number,
): Record<string, unknown> {
  const value = { ...row },
    historical = value[key] !== epoch;
  delete value[key];
  if (kind === "runs") {
    const metadata = { ...(value.metadata as Record<string, unknown>) };
    delete metadata.executionLease;
    delete metadata.recovery;
    value.metadata = metadata;
    if (
      historical &&
      ["running", "queued", "waiting_permission", "waiting_input"].includes(
        String(value.status),
      )
    ) {
      value.status = "interrupted";
      value.stopReason = "history_restored";
    }
  }
  if (
    historical &&
    kind === "steps" &&
    ["running", "waiting_permission", "waiting_input"].includes(
      String(value.status),
    )
  ) {
    value.status = "interrupted";
    value.finishReason = "history_restored";
  }
  if (
    historical &&
    kind === "tools" &&
    ["pending", "running"].includes(String(value.status))
  ) {
    value.status = "failed";
    value.error = "Execution is outside the current history epoch.";
  }
  if (historical && kind === "permissions" && !value.resolvedAt) {
    value.action = "deny";
    value.userReply = "reject";
    value.resumeToken = null;
  }
  if (historical && kind === "interactions" && value.status === "pending")
    value.status = "cancelled";
  return value;
}
export function readVersionEntity<T>(
  sessionId: string,
  kind: string,
  id: string,
  live?: T,
): T {
  return readVersionSnapshot(getRawSqlite(), () => {
    const repo = versionRepository(),
      head = repo.head(sessionId),
      row = boundaryOnlySession(sessionId) && (isDiagnostic(kind) || appendOnlySession(sessionId)) ? readDiagnostic(sessionId, kind, id) : repo.get(sessionId, kind, id);
    if (!row) throw new AgentNotFoundError(id);
    const result = {
      ...normalizeVersionEntity(kind, row, head.epoch),
      ...(row[key] === head.epoch
        ? currentControl(sessionId, kind, id, head.epoch)
        : {}),
    };
    if (kind === "runs" && row[key] === head.epoch && live) {
      // Only the live execution accessor gets the current lease, never history lists.
      result.metadata = {
        ...(result.metadata as Record<string, unknown>),
        ...((live as Record<string, unknown>).metadata as Record<
          string,
          unknown
        >),
      };
      result.status = (live as Record<string, unknown>).status;
    }
    return result as T;
  });
}
export function listVersionEntities<T>(
  sessionId: string,
  kind: string,
  scope?: { field: string; value: string },
): T[] {
  return readVersionSnapshot(getRawSqlite(), () => {
    const repo = versionRepository(),
      head = repo.head(sessionId),
      page = boundaryOnlySession(sessionId) && (isDiagnostic(kind) || appendOnlySession(sessionId))
        ? { ...diagnosticPage(sessionId, kind, { limit: 256, scope }), next: undefined }
        : repo.page(sessionId, kind, { limit: 256, scope });
    if (page.next)
      throw new AgentRuntimeError(
        "Execution history requires pagination.",
        "HISTORY_PAGE_REQUIRED",
        413,
      );
    return page.items.map((row) => ({
      ...normalizeVersionEntity(kind, row, head.epoch),
      ...(row[key] === head.epoch
        ? currentControl(sessionId, kind, String(row.id), head.epoch)
        : {}),
    })) as T[];
  });
}
