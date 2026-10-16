import { interruptContextCompaction } from "./context-compaction-state.js";
import { hasInput } from "./content-parts.js";
import { getRawSqlite } from "../../infrastructure/database/index.js";
import { agentRuntimeStore } from "./session-store.js";
import { interactionService } from "./interaction-service.js";
import { permissionPolicy } from "./permission-policy.js";
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
import type { AgentRun, AgentSession, StreamTurnRequest } from "./contracts.js";

export function isDurableRuntimeCheckpoint(status: string): boolean {
  return status === "waiting_permission" || status === "waiting_input";
}

async function recoverAuthoritativeRuntime(
  hostId: string,
): Promise<{ reviewed: number; resumable: string[] }> {
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  const unresolved = await recoverOwnedProcesses(hostId);
  const projections = await runtimeFacade.listSessionProjection();
  const resumable: string[] = [];
  let reviewed = 0;
  for (const item of projections) {
    const session = item as AgentSession;
    const [snapshot, control, historyRuns] = await Promise.all([
      runtimeFacade.uiSnapshotAuthoritative(session.id),
      runtimeFacade.controlState(session.id) as Promise<{ runtimeControl?: unknown; processLeases?: unknown[] }>,
      runtimeFacade.listRunHistory(session.id),
    ]);
    const local = agentRuntimeStore.tryGetSession(session.id);
    const runs = historyRuns as AgentRun[];
    const active =
      ((snapshot.run as AgentRun | null | undefined) &&
        ["queued", "running", "waiting_permission", "waiting_input"].includes(
          (snapshot.run as AgentRun).status,
        )
        ? (snapshot.run as AgentRun)
        : undefined) ??
      runs.find((run) =>
        ["queued", "running", "waiting_permission", "waiting_input"].includes(
          run.status,
        ),
      );
    const leases = Array.isArray(control.processLeases) ? control.processLeases : [];
    const processUnknown =
      leases.length > 0 || unresolved.some((record) => record.session_id === session.id);
    const localRuns = local ? agentRuntimeStore.listRuns(session.id) : [];
    const checkpoint = local ? findDurableCheckpoint(session.id, localRuns) : null;
    if (
      active &&
      isDurableRuntimeCheckpoint(active.status) &&
      !processUnknown
    ) {
      if (
        checkpoint &&
        ((active.status === "waiting_input" && interactionService.ready(session.id)) ||
          (active.status === "waiting_permission" &&
            permissionPolicy.list(session.id).some((permission) => permission.userReply !== null)))
      )
        resumable.push(session.id);
      continue;
    }
    if (
      !active &&
      !control.runtimeControl &&
      !processUnknown &&
      !["running", "stopping", "queued"].includes(session.status)
    )
      continue;

    const reason = processUnknown
      ? "Process shutdown remains unconfirmed after runtime restart."
      : active
        ? "The runtime restarted during execution. The previous run was interrupted."
        : "The runtime restarted without a confirmed active run. Continue the session explicitly.";
    if (active && !processUnknown) {
      const finalRun: AgentRun = {
        ...active,
        status: "interrupted",
        completedAt: nowIso(),
        stopReason: reason,
        metadata: {
          ...active.metadata,
          recovery: { phase: active.status, at: nowIso() },
          executionLease: {
            ...((active.metadata.executionLease as object | undefined) ?? {}),
            closed: true,
          },
        },
      };
      await runtimeFacade.finishExecution(session.id, finalRun);
      await runtimeFacade.sessionPatch(session.id, `recovery:${session.id}:${finalRun.id}`, {
        status: "paused",
        activeRunId: null,
        pendingResumeToken: null,
        blockedReason: reason,
        completedAt: null,
        updatedAt: finalRun.completedAt,
        sessionMetadata: { runtimeControl: null },
      });
      if (local) {
        try {
          agentRuntimeStore.updateRun(finalRun.id, finalRun);
          agentRuntimeStore.updateSession(session.id, {
            status: "paused",
            activeRunId: null,
            pendingResumeToken: null,
            blockedReason: reason,
            updatedAt: finalRun.completedAt!,
            sessionMetadata: { ...(local.sessionMetadata ?? {}), runtimeControl: null },
          });
        } catch {
          // Rust is the authority; a missing compatibility mirror is recoverable.
        }
      }
    } else {
      await runtimeFacade.controlCommand({
        sessionId: session.id,
        requestId: `recovery-unconfirmed:${session.id}`,
        operation: "stop_unconfirmed",
        payload: { runId: (snapshot.session as AgentSession).activeRunId, reason },
      });
      if (local) {
        try {
          agentRuntimeStore.updateSessionMetadata(session.id, {
            runtimeControl: { state: "unconfirmed", source: "restart", reason },
          });
        } catch {
          // Keep the durable Rust recovery fence even when the mirror is stale.
        }
      }
    }
    reviewed++;
  }
  return { reviewed, resumable };
}

type DurableCheckpoint = {
  runId: string;
  status: "waiting_permission" | "waiting_input";
  pendingResumeToken: string;
  blockedReason: string;
};

function findDurableCheckpoint(
  sessionId: string,
  runs: ReturnType<typeof agentRuntimeStore.listRuns>,
): DurableCheckpoint | null {
  const interaction = interactionService.pending(sessionId);
  if (interaction) {
    const run = runs.find((item) => item.id === interaction.runId);
    if (run)
      return {
        runId: run.id,
        status: "waiting_input",
        pendingResumeToken: `interaction:${interaction.id}`,
        blockedReason: interaction.request.title,
      };
  }
  const permission = permissionPolicy
    .list(sessionId)
    .find(
      (item) =>
        item.action === "ask" &&
        item.userReply === null &&
        item.resolvedAt === null &&
        item.runId,
    );
  if (!permission?.runId) return null;
  const run = runs.find((item) => item.id === permission.runId);
  if (!run || !permission.resumeToken) return null;
  return {
    runId: run.id,
    status: "waiting_permission",
    pendingResumeToken: permission.resumeToken,
    blockedReason: permission.reason,
  };
}

export async function recoverRuntime(
  hostId: string,
): Promise<{ reviewed: number; resumable: string[] }> {
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === "authoritative")
    return recoverAuthoritativeRuntime(hostId);
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
      interruptContextCompaction(
        session.id,
        "API restarted before context compaction completed. Please retry.",
      );
      const runs = agentRuntimeStore.listRuns(session.id);
      const checkpoint = findDurableCheckpoint(session.id, runs);
      const checkpointRun = checkpoint
        ? runs.find((item) => item.id === checkpoint.runId)
        : undefined;
      const run =
        checkpointRun ??
        runs.find((item) =>
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
        !["running", "stopping", "queued"].includes(session.status) &&
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
      const recoverableCheckpoint =
        checkpoint &&
        checkpointRun &&
        native &&
        !embedded &&
        !session.parentSessionId;
      if (recoverableCheckpoint) {
        agentRuntimeStore.updateRun(checkpointRun.id, {
          status: checkpoint.status,
          completedAt: null,
          stopReason: null,
        });
        agentRuntimeStore.updateSession(session.id, {
          status: checkpoint.status,
          activeRunId: checkpointRun.id,
          pendingResumeToken: checkpoint.pendingResumeToken,
          blockedReason: checkpoint.blockedReason,
          resultSummary: null,
          completedAt: null,
          updatedAt: nowIso(),
          ...(session.sessionMetadata?.runtimeControl
            ? {
                sessionMetadata: {
                  ...session.sessionMetadata,
                  runtimeControl: null,
                },
              }
            : {}),
        });
        if (!unknownProcesses.length) {
          const answeredPermission = db
            .prepare(
              "SELECT p.id FROM agent_runtime_permissions p JOIN agent_runtime_tool_calls t ON t.id=p.tool_call_id WHERE p.run_id=? AND p.user_reply IS NOT NULL AND t.status='pending' LIMIT 1",
            )
            .get(checkpointRun.id);
          const answeredInput = db
            .prepare(
              "SELECT id FROM agent_runtime_interactions WHERE run_id=? AND consumed_at IS NULL AND response_json IS NOT NULL LIMIT 1",
            )
            .get(checkpointRun.id);
          if (answeredPermission || answeredInput) resumable.push(session.id);
        }
        continue;
      }
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
      const reason = !run && !shutdownUnconfirmed
        ? "The runtime restarted without a confirmed active run. Continue the session explicitly."
        : shutdownUnconfirmed
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
        status: shutdownUnconfirmed ? "completed" : "paused",
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
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === "authoritative") {
    const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
    await runtimeFacade.controlCommand({
      sessionId,
      requestId: `recovery-ack:${sessionId}`,
      operation: "resume",
      payload: { runId: session.activeRunId },
    });
  }
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
