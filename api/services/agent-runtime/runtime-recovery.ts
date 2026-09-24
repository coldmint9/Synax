import { hasInput } from "./content-parts.js";
import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";
import { profileService } from "./profile-service.js";
import {
  recoverOwnedProcesses,
  stopRecordedProcess,
  type OwnedProcessRecord,
} from "./process-ownership.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { nowIso } from "./runtime-ids.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { StreamTurnRequest } from "./contracts.js";

export function isDurableRuntimeCheckpoint(status: string): boolean {
  return status === "waiting_permission" || status === "waiting_input";
}

export async function recoverRuntime(
  hostId: string,
): Promise<{ reviewed: number; resumable: string[] }> {
  const db = getRawSqlite();
  // Revoke business writes before inspecting or terminating old processes.
  db.prepare(
    "UPDATE agent_runtime_runs SET metadata_json=json_set(metadata_json, '$.executionLease.closed', json('true')) WHERE json_extract(metadata_json, '$.executionLease.epoch') IS NOT NULL",
  ).run();
  const unresolved = await recoverOwnedProcesses(hostId);
  const resumable: string[] = [];
  let reviewed = 0;
  runtimeTransaction(() => {
    for (const session of agentRuntimeStore.listSessions({
      limit: Number.MAX_SAFE_INTEGER,
    })) {
      const runs = agentRuntimeStore.listRuns(session.id);
      const run = runs.find((item) =>
        ["running", "queued", "waiting_permission", "waiting_input"].includes(
          item.status,
        ),
      );
      const unknownProcesses = unresolved.filter(
        (item) => item.session_id === session.id,
      );
      if (
        !run &&
        !session.sessionMetadata?.runtimeControl &&
        !unknownProcesses.length
      )
        continue;
      const backend = session.sessionMetadata?.backend as
        | { id?: string }
        | undefined;
      const native =
        (backend?.id ?? (session.sessionMetadata?.acp ? "acp" : "native")) ===
        "native";
      let embedded = true;
      try {
        embedded =
          profileService.getForSession(session).executionHost === "embedded";
      } catch {
        /* Unknown profiles are not resumed automatically. */
      }
      const safeCheckpoint =
        run &&
        native &&
        !embedded &&
        !session.parentSessionId &&
        !session.sessionMetadata?.runtimeControl &&
        !unknownProcesses.length &&
        isDurableRuntimeCheckpoint(run.status);
      if (safeCheckpoint) {
        agentRuntimeStore.updateSession(session.id, {
          status: normalizeAgentSessionStatus(run.status),
          activeRunId: run.id,
        });
        const answeredPermission = db
          .prepare(
            "SELECT p.id FROM agent_runtime_permissions p JOIN agent_runtime_tool_calls t ON t.id=p.tool_call_id WHERE p.run_id=? AND p.user_reply IS NOT NULL AND t.status='pending' LIMIT 1",
          )
          .get(run.id);
        const answeredInput = db
          .prepare(
            "SELECT id FROM agent_runtime_interactions WHERE run_id=? AND consumed_at IS NULL AND response_json IS NOT NULL LIMIT 1",
          )
          .get(run.id);
        if (answeredPermission || answeredInput) resumable.push(session.id);
        continue;
      }
      const phase = run?.status ?? "shutdown";
      const shutdownUnconfirmed = unknownProcesses.length > 0;
      const reason = shutdownUnconfirmed
        ? "Process shutdown remains unconfirmed. Retry stopping the recorded process in this session."
        : phase === "queued"
          ? "The runtime restarted before this request was launched."
          : "The runtime restarted during execution. The previous run was interrupted.";
      if (run) {
        agentRuntimeStore.updateRun(run.id, {
          status: "interrupted",
          completedAt: nowIso(),
          stopReason: reason,
          metadata: {
            ...run.metadata,
            executionLease: {
              ...((run.metadata.executionLease as object) ?? {}),
              closed: true,
            },
            recovery: { phase, at: nowIso() },
          },
        });
        db.prepare(
          "UPDATE agent_runtime_run_steps SET status='interrupted', completed_at=?, finish_reason='server_restarted' WHERE run_id=? AND status='running'",
        ).run(nowIso(), run.id);
        db.prepare(
          "UPDATE agent_runtime_permissions SET action='deny', user_reply='reject', resolved_at=?, reason='Native request expired on restart.' WHERE run_id=? AND resolved_at IS NULL",
        ).run(nowIso(), run.id);
        db.prepare(
          "UPDATE agent_runtime_interactions SET status='cancelled', consumed_at=? WHERE run_id=? AND consumed_at IS NULL",
        ).run(nowIso(), run.id);
      }
      const recoveredAt = nowIso();
      agentRuntimeStore.updateSessionMetadata(session.id, {
        runtimeControl: shutdownUnconfirmed
          ? { state: "unconfirmed", source: "restart", reason }
          : null,
      });
      agentRuntimeStore.updateSession(session.id, {
        status: shutdownUnconfirmed ? "completed" : "interrupted",
        activeRunId: null,
        pendingResumeToken: null,
        blockedReason: reason,
        updatedAt: recoveredAt,
        completedAt: shutdownUnconfirmed ? recoveredAt : session.completedAt,
      });
      reviewed++;
    }
  });
  return { reviewed, resumable };
}

export function restoreUnlaunchedInput(
  sessionId: string,
  input: StreamTurnRequest,
): StreamTurnRequest {
  if (hasInput(input)) return input;
  const last = agentRuntimeStore.listRuns(sessionId)[0];
  if (
    (last?.metadata.recovery as { phase?: string } | undefined)?.phase !==
    "queued"
  )
    return input;
  const accepted = last.metadata.runtime as
    | { input?: StreamTurnRequest }
    | undefined;
  return accepted?.input ? { ...accepted.input, ...input } : input;
}

export async function acknowledgeRuntimeRecovery(
  sessionId: string,
): Promise<void> {
  const session = agentRuntimeStore.getSession(sessionId);
  const records = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_processes WHERE session_id=? AND state<>'closed'",
    )
    .all(sessionId) as OwnedProcessRecord[];
  for (const record of records)
    if (!(await stopRecordedProcess(record)))
      throw new AgentRuntimeError(
        "A recorded process is still unconfirmed; this session cannot resume yet. Retry process cleanup.",
        "PROCESS_UNCONFIRMED",
        409,
      );
  if (!session.sessionMetadata?.runtimeControl) return;
  agentRuntimeStore.updateSessionMetadata(sessionId, {
    runtimeControl: null,
    lastRecoveryAcknowledgedAt: nowIso(),
  });
  agentRuntimeStore.updateSession(sessionId, {
    status: "interrupted",
    activeRunId: null,
    blockedReason: null,
    pendingResumeToken: null,
    updatedAt: nowIso(),
  });
}
