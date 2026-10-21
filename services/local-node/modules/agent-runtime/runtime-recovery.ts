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
import type { AgentRun, AgentSession, StreamTurnRequest } from "./contracts.js";
import type { RuntimeExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { runtimeClient } from "./sidecar/runtime-repository.js";
import { logger } from "../../infrastructure/runtime/logger.js";

/** Restart cleanup is bounded and automatic. A lease whose ownership cannot be
 * proven must never leave a session waiting on a human decision. */
const STOP_ATTEMPTS = 3;
const STOP_BACKOFF_MS = 150;

export function currentRuntimeHostId(): string {
  return process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`;
}

/** Completed summaries with no live lease/fence can stay cold at startup. */
export function needsRuntimeRecovery(session: AgentSession): boolean {
  return session.runtimeRecoveryRequired !== false || Boolean(session.activeRunId) ||
    ["running", "stopping", "queued"].includes(session.status);
}

async function stopLeases(
  records: OwnedProcessRecord[],
): Promise<OwnedProcessRecord[]> {
  let unresolved = records;
  for (let attempt = 1; attempt <= STOP_ATTEMPTS && unresolved.length; attempt++) {
    if (attempt > 1)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STOP_BACKOFF_MS * (attempt - 1)),
      );
    const retry: OwnedProcessRecord[] = [];
    for (const record of unresolved) {
      registerAuthoritativeLease(record);
      if (!(await stopRecordedProcess(record))) retry.push(record);
    }
    unresolved = retry;
  }
  return unresolved;
}

/** Unverifiable ownership is released and logged instead of blocking the
 * session forever: the recorded pid may already belong to another process. */
async function releaseLeases(
  sessionId: string,
  records: OwnedProcessRecord[],
): Promise<Array<Record<string, unknown>>> {
  if (!records.length) return [];
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  const released: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const detail = {
      leaseId: record.id,
      pid: record.pid,
      commandLabel: record.command_label,
      hostId: record.host_id,
    };
    await runtimeFacade
      .controlCommand({
        sessionId,
        requestId: `release-unconfirmed:${sessionId}:${record.id}`,
        operation: "lease_close",
        payload: { leaseId: record.id },
      })
      .catch((error) =>
        logger.warn(
          { sessionId, ...detail, error },
          "Unconfirmed process lease could not be released",
        ),
      );
    logger.warn(
      { sessionId, ...detail },
      "Process ownership was not confirmed after restart; the lease is released",
    );
    released.push(detail);
  }
  return released;
}

/** A fence identity keeps the acknowledgement idempotent per fence instead of
 * colliding with an older receipt for the same session. */
function fenceIdentity(runtimeControl: unknown): string {
  if (runtimeControl && typeof runtimeControl === "object") {
    const marker = runtimeControl as { runId?: unknown; updatedAt?: unknown };
    const parts = [marker.runId, marker.updatedAt].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(":");
  }
  return nowIso();
}

/** `stop_ack` is the operation that clears the durable stop fence and leaves the
 * projection interrupted; `resume` assumes a run that can continue. */
async function clearControlFence(
  sessionId: string,
  runId: string,
  reason: string,
  runtimeControl: unknown,
): Promise<void> {
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  await runtimeFacade.controlCommand({
    sessionId,
    requestId: `recovery-stop-ack:v2:${sessionId}:${fenceIdentity(runtimeControl)}`,
    operation: "stop_ack",
    payload: { runId, reason },
  });
}

async function settleRuntimeFence(
  sessionId: string,
  session: AgentSession,
  reason: string,
  released: Array<Record<string, unknown>>,
  runtimeControl: unknown,
): Promise<void> {
  const { runtimeFacade } = await import("./sidecar/runtime-facade.js");
  // The acknowledgement projects "interrupted"; a session that was already
  // finished keeps its own status so the restart is not reported as a stop.
  const status =
    session.activeRunId || ["running", "stopping", "queued"].includes(session.status)
      ? "interrupted"
      : session.status;
  const blockedReason = released.length ? reason : null;
  await clearControlFence(sessionId, session.activeRunId ?? "", reason, runtimeControl);
  await runtimeFacade.sessionPatch(
    sessionId,
    `recovery-fence:${sessionId}:${fenceIdentity(runtimeControl)}`,
    {
      status,
      activeRunId: null,
      pendingResumeToken: null,
      blockedReason,
      updatedAt: nowIso(),
      sessionMetadata: { runtimeControl: null },
    },
  );
  if (!agentRuntimeStore.tryGetSession(sessionId)) return;
  agentRuntimeStore.updateSessionMetadata(sessionId, {
    runtimeControl: null,
    ...(released.length
      ? { runtimeRecovery: { state: "released", at: nowIso(), leases: released } }
      : {}),
  });
  agentRuntimeStore.updateSession(sessionId, {
    status,
    activeRunId: null,
    pendingResumeToken: null,
    blockedReason,
    updatedAt: nowIso(),
  });
  await agentRuntimeStore.flushSession(sessionId);
}

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
  const leases: OwnedProcessRecord[] = [];
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
    leases.push(record);
  }
  const unresolved = await stopLeases(leases);
  const processUnknown = unresolved.length > 0;
  if (!execution.activeRunId && !control.runtimeControl && !processUnknown &&
      !["running", "stopping", "queued"].includes(session.status)) return unchanged;

  if (!execution.activeRunId) {
    // Nothing is executing, so this fence can only block the session. Settle it
    // here instead of parking a manual retry in front of the composer.
    const released = await releaseLeases(sessionId, unresolved);
    await settleRuntimeFence(
      sessionId,
      session,
      released.length
        ? "Process shutdown remains unconfirmed after runtime restart."
        : "The runtime restarted without a confirmed active run.",
      released,
      control.runtimeControl,
    );
    return { reviewed: 1, resumable: [] };
  }

  // The common completed/idle case above never loads transcript collections.
  const active = execution.activeRunId
    ? snapshot.run?.id === execution.activeRunId ? snapshot.run
      : (await runtimeFacade.listRunHistory(sessionId) as AgentRun[]).find(run => run.id === execution.activeRunId)
    : undefined;
  await agentRuntimeStore.hydrateSession(sessionId, true);
  const local = agentRuntimeStore.tryGetSession(sessionId);
  const reason = processUnknown
    ? "Process shutdown remains unconfirmed after runtime restart."
    : active
      ? "The runtime restarted during execution. The previous run was interrupted."
      : "The runtime restarted without a confirmed active run.";
  if (!active) {
    await settleRuntimeFence(
      sessionId,
      session,
      reason,
      await releaseLeases(sessionId, unresolved),
      control.runtimeControl,
    );
    return { reviewed: 1, resumable: [] };
  }
  if (active && !processUnknown && ["completed", "failed", "blocked", "cancelled", "interrupted"].includes(active.status)) {
    await runtimeFacade.finishExecution(sessionId, active);
    if (control.runtimeControl) {
      await clearControlFence(sessionId, active.id, reason, control.runtimeControl);
      // The acknowledgement projects "interrupted"; restore what the finished
      // run actually was so the session does not look stopped by the user.
      await runtimeFacade.sessionPatch(
        sessionId,
        `recovery-fence:${sessionId}:${active.id}`,
        {
          status: normalizeAgentSessionStatus(active.status),
          activeRunId: null,
          blockedReason: null,
          sessionMetadata: { runtimeControl: null },
        },
      );
    }
    await agentRuntimeStore.hydrateSession(sessionId, true);
    return { reviewed: 1, resumable: [] };
  }
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
    // `finish` closes the execution lease but keeps the durable stop fence;
    // without this ack the session could never open a new execution again.
    await clearControlFence(session.id, finalRun.id, reason, control.runtimeControl);
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
    // A recorded run whose processes could not be confirmed: interrupt it and
    // settle the fence in the same pass. Leases that cannot be verified are
    // released with a log entry, never left for the user to retry by hand.
    await settleRuntimeFence(
      session.id,
      session,
      reason,
      await releaseLeases(session.id, unresolved),
      control.runtimeControl,
    );
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
