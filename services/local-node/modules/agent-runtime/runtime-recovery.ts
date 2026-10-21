import { interruptContextCompaction } from "./context-compaction-state.js";
import { hasInput } from "./content-parts.js";
import { agentRuntimeStore } from "./session-store.js";
import { interactionService } from "./interaction-service.js";
import { permissionPolicy } from "./permission-policy.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";
import { profileService } from "./profile-service.js";
import {
  registerAuthoritativeLease,
  stopRecordedProcess,
  type OwnedProcessRecord,
} from "./process-ownership.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { nowIso } from "./runtime-ids.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { AgentRun, AgentSession, StreamTurnRequest } from "./contracts.js";
import type { RuntimeExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { runtimeClient } from "./sidecar/runtime-repository.js";

/** Recover one session before admitting new work; unrelated sessions never wait. */
export async function recoverRuntimeSession(
  hostId: string,
  sessionId: string,
  includeCurrentHost = false,
): Promise<{ reviewed: number; resumable: string[] }> {
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  const [snapshot, control, execution] = await Promise.all([
    runtimeFacade.uiSnapshotAuthoritative(sessionId),
    runtimeFacade.controlState(sessionId) as Promise<{ runtimeControl?: unknown; processLeases?: unknown[]; executionLease?: RuntimeExecutionContext & { closed: boolean } }>,
    runtimeClient().snapshot(sessionId),
  ]);
  const session = snapshot.session as AgentSession;
  const unchanged = { reviewed: 0, resumable: [] as string[] };
  // A session admitted after boot belongs to this host and must not be swept
  // later by a slower background enumeration.
  if (!includeCurrentHost && control.executionLease?.hostId === hostId && !control.executionLease.closed) return unchanged;
  let processUnknown = false;
  for (const raw of Array.isArray(control.processLeases) ? control.processLeases : []) {
    if (!raw || typeof raw !== "object") continue;
    const lease = raw as Record<string, unknown>;
    if (lease.hostId === hostId && !includeCurrentHost) continue;
    const record: OwnedProcessRecord = {
      id: String(lease.leaseId ?? ""),
      host_id: typeof lease.hostId === "string" ? lease.hostId : "unknown",
      session_id: sessionId,
      run_id: typeof lease.runId === "string" ? lease.runId : null,
      pid: typeof lease.pid === "number" ? lease.pid : null,
      process_group: typeof lease.processGroup === "number" ? lease.processGroup : 0,
      command_label: typeof lease.commandLabel === "string" ? lease.commandLabel : "runtime process",
      state: typeof lease.state === "string" ? lease.state : "active",
      runtime_kind: lease.runtimeKind === "wsl" ? "wsl" : undefined,
      runtime_distribution: typeof lease.runtimeDistribution === "string" ? lease.runtimeDistribution : null,
      runtime_pid: typeof lease.runtimePid === "number" ? lease.runtimePid : null,
      runtime_pgid: typeof lease.runtimePgid === "number" ? lease.runtimePgid : null,
    };
    if (!record.id) continue;
    registerAuthoritativeLease(record);
    if (!(await stopRecordedProcess(record))) processUnknown = true;
  }
  if (!execution.activeRunId && !control.runtimeControl && !processUnknown &&
      !["running", "stopping", "queued"].includes(session.status)) return unchanged;
  if (!execution.activeRunId && control.runtimeControl != null && !processUnknown)
    return { reviewed: 1, resumable: [] };

  // The common completed/idle case above never loads transcript collections.
  const active = execution.activeRunId
    ? snapshot.run?.id === execution.activeRunId ? snapshot.run
      : (await runtimeFacade.listRunHistory(sessionId) as AgentRun[]).find(run => run.id === execution.activeRunId)
    : undefined;
  await agentRuntimeStore.hydrateSession(sessionId, true);
  const local = agentRuntimeStore.tryGetSession(sessionId);
  if (active && !processUnknown && ["completed", "failed", "blocked", "cancelled", "interrupted"].includes(active.status)) {
    await runtimeFacade.finishExecution(sessionId, active);
    await agentRuntimeStore.hydrateSession(sessionId, true);
    return { reviewed: 1, resumable: [] };
  }
  const reason = processUnknown
    ? "Process shutdown remains unconfirmed after runtime restart."
    : active
      ? "The runtime restarted during execution. The previous run was interrupted."
      : "The runtime restarted without a confirmed active run. Continue the session explicitly.";
  if (active && !processUnknown) {
    // Close the old executor before changing any user-visible pending work.
    const lease = control.executionLease;
    if (lease && !lease.closed) await runtimeFacade.controlCommand({ sessionId: session.id,
      requestId: `restart-close:${active.id}:${lease.epoch}`, operation: "execution_close", payload: lease });
    if (local) {
      interruptContextCompaction(session.id, "运行进程已重启，上下文压缩已中断。");
      interactionService.cancel(session.id);
      for (const permission of agentRuntimeStore.listPermissions(session.id)) {
        if (permission.runId !== active.id || permission.action !== "ask" || permission.resolvedAt) continue;
        agentRuntimeStore.updatePermission(session.id, permission.id, {
          action: "deny", resolvedAt: nowIso(), resumeToken: null,
          reason: "运行已中断，原权限请求已失效。", metadata: { ...permission.metadata, expiredByRestart: true },
        });
        agentRuntimeStore.enqueueControl(session.id, `restart-permission:${permission.id}`, "permission_expire", { id: permission.id });
      }
      for (const step of agentRuntimeStore.listRunSteps(active.id)) {
        if (["running", "waiting_input", "waiting_permission"].includes(step.status))
          agentRuntimeStore.updateRunStep(step.id, { status: "interrupted", completedAt: nowIso(), finishReason: "runtime_restart" });
      }
      for (const call of agentRuntimeStore.listToolCalls(session.id)) {
        if (call.runId === active.id && ["pending", "running"].includes(call.status))
          agentRuntimeStore.updateToolCall(session.id, call.id, { status: "failed", endedAt: nowIso(), error: "运行进程已重启；未确认工具执行结果，未自动重试。" });
      }
      await agentRuntimeStore.flushSession(session.id);
    }
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
      // The original recovery request id was also used by older builds with
      // a nullable runId. Keep this recovery command on a new semantic id so
      // an old receipt cannot turn a harmless restart into REQUEST_CONFLICT.
      requestId: `recovery-unconfirmed:v2:${session.id}`,
      operation: "stop_unconfirmed",
      // Rust projections encode an absent active run as an empty string in
      // some legacy snapshots; the request identity must stay canonical.
      payload: {
        runId: (snapshot.session as AgentSession).activeRunId || null,
        reason,
      },
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
  await agentRuntimeStore.flushSession(sessionId);
  return { reviewed: 1, resumable: [] };
}

/** Explicit complete recovery for fixtures/maintenance. Boot uses the per-session scheduler. */
export async function recoverRuntime(
  hostId: string,
  includeCurrentHost = false,
): Promise<{ reviewed: number; resumable: string[] }> {
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  const sessions = await runtimeFacade.listSessionProjection() as AgentSession[];
  let cursor = 0;
  let reviewed = 0;
  const worker = async () => {
    while (cursor < sessions.length) {
      const session = sessions[cursor++];
      reviewed += (await recoverRuntimeSession(hostId, session.id, includeCurrentHost)).reviewed;
    }
  };
  await Promise.all([worker(), worker()]);
  return { reviewed, resumable: [] };
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
  const session = (await import("./sidecar/runtime-facade.js")).runtimeFacade.uiSnapshotAuthoritative(sessionId).then((snapshot) => snapshot.session as AgentSession);
  const resolvedSession = await session;
  const records = (((await import("./sidecar/runtime-facade.js")).runtimeFacade.controlState(sessionId) as Promise<{ processLeases?: unknown[] }>).then((state) => (Array.isArray(state.processLeases) ? state.processLeases : []).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const lease = raw as Record<string, unknown>;
        if (typeof lease.leaseId !== "string") return [];
        const record = { id: lease.leaseId, host_id: String(lease.hostId ?? "unknown"), session_id: sessionId, run_id: typeof lease.runId === "string" ? lease.runId : null, pid: typeof lease.pid === "number" ? lease.pid : null, process_group: typeof lease.processGroup === "number" ? lease.processGroup : 0, command_label: typeof lease.commandLabel === "string" ? lease.commandLabel : "runtime process", state: typeof lease.state === "string" ? lease.state : "active", runtime_kind: lease.runtimeKind === "wsl" ? "wsl" : undefined, runtime_distribution: typeof lease.runtimeDistribution === "string" ? lease.runtimeDistribution : null, runtime_pid: typeof lease.runtimePid === "number" ? lease.runtimePid : null, runtime_pgid: typeof lease.runtimePgid === "number" ? lease.runtimePgid : null } as OwnedProcessRecord;
        registerAuthoritativeLease(record);
        return [record];
      })));
  const resolvedRecords = await records;
  for (const record of resolvedRecords)
    if (!(await stopRecordedProcess(record)))
      throw new AgentRuntimeError(
        "A recorded process is still unconfirmed; this session cannot resume yet. Retry process cleanup.",
        "PROCESS_UNCONFIRMED",
        409,
      );
  if (!resolvedSession.sessionMetadata?.runtimeControl) return;
  {
    const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
    await runtimeFacade.controlCommand({
      sessionId,
      requestId: `recovery-ack:${sessionId}`,
      operation: "resume",
      payload: { runId: resolvedSession.activeRunId },
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
  await agentRuntimeStore.flushSession(sessionId);
}
