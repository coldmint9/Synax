import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { applySessionPermissionUpdate } from "./session-permissions.js";
import { withDeadline } from "./managed-process.js";
import { restoreUnlaunchedInput } from "./runtime-recovery.js";
import { profileService } from "./profile-service.js";
import { randomUUID } from "node:crypto";
import {
  withinExecutionContext,
  type RuntimeExecutionContext,
} from "../../lib/execution-context.js";
import { RuntimeStreamWriter } from "./runtime-stream-writer.js";
import { agentEventService } from "./event-service.js";
import type { AgentSessionStreamMode } from "../../lib/ipc/agent-session-protocol.js";
import type { AgentRunStreamChunk, StreamTurnRequest } from "./contracts.js";
import { getRawSqlite } from "../../db/index.js";
import {
  acceptRuntimeRun,
  type AcceptedRuntimeInput,
} from "./run-admission.js";
import { executeBackendSession } from "./backend-execution.js";
import { getBackendAdapter } from "./backends/backend-registry.js";
import {
  resolveSessionBackend,
  validateBackendTurnInput,
} from "./backends/backend-binding.js";
import { agentRuntimeStore } from "./session-store.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";
import { runtimeJournal, type RuntimeStreamRecord } from "./runtime-journal.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";
import { goalContinuationInput } from "./goal-continuation.js";
import { inputQueueService } from "./input-queue-service.js";
import { interactionService } from "./interaction-service.js";
import { workStore } from "./work-store.js";
import { logger } from "../../lib/logger.js";

interface Owner {
  context?: RuntimeExecutionContext;
  runId: string;
  controller: AbortController;
  task: Promise<void>;
  stopping: boolean;
  stopTask?: Promise<void>;
  stopFailed?: boolean;
  finalizers?: Array<() => void>;
}
interface Driver {
  execute: typeof executeBackendSession;
  interrupt: (sessionId: string, reason: string) => Promise<void>;
}
const defaultDriver: Driver = {
  execute: executeBackendSession,
  async interrupt(id, reason) {
    for (const session of agentRuntimeStore.listSessionTree(id)) {
      await getBackendAdapter(resolveSessionBackend(session.id).id).interrupt(
        session.id,
        reason,
      );
    }
  },
};

export class RunCoordinator {
  private readonly owners = new Map<string, Owner>();
  private readonly pendingResumes = new Map<string, StreamTurnRequest>();
  constructor(private readonly driver: Driver = defaultDriver) {}

  isActive(sessionId: string): boolean {
    return this.owners.has(sessionId);
  }
  isStopping(sessionId: string): boolean {
    return Boolean(this.owners.get(sessionId)?.stopping);
  }

  private acceptRun(
    sessionId: string,
    input: StreamTurnRequest,
    requestId: string,
    mode: AgentSessionStreamMode,
  ): ReturnType<typeof acceptRuntimeRun> {
    if (this.isActive(sessionId)) {
      const previous = getRawSqlite()
        .prepare(
          `SELECT id FROM agent_runtime_runs WHERE session_id = ?
        AND json_extract(metadata_json, '$.runtime.requestId') = ?`,
        )
        .get(sessionId, requestId);
      if (!previous)
        throw new AgentRuntimeError(
          "The previous execution has not released this session.",
          "SESSION_BUSY",
          409,
        );
    }
    const restored =
      mode === "continue" ? restoreUnlaunchedInput(sessionId, input) : input;
    return acceptRuntimeRun(sessionId, restored, requestId, mode);
  }

  private launchAccepted(
    sessionId: string,
    accepted: ReturnType<typeof acceptRuntimeRun>,
    mode: AgentSessionStreamMode,
  ): void {
    if (accepted.reused && this.isActive(sessionId)) return;
    const run = agentRuntimeStore.getRun(accepted.run.id);
    if (run.status !== "queued") return;
    const runtime = run.metadata.runtime as AcceptedRuntimeInput;
    this.launch(sessionId, run.id, mode, {
      ...runtime.input,
      acceptedRunId: run.id,
    });
  }

  submit(
    sessionId: string,
    input: StreamTurnRequest,
    requestId: string,
    mode: AgentSessionStreamMode = "turn",
  ) {
    const accepted = this.acceptRun(sessionId, input, requestId, mode);
    this.launchAccepted(sessionId, accepted, mode);
    return accepted;
  }

  resume(sessionId: string, input: StreamTurnRequest = {}): void {
    const owner = this.owners.get(sessionId);
    if (owner?.stopping) return;
    const session = agentRuntimeStore.getSession(sessionId);
    if (session.sessionMetadata?.runtimeControl)
      throw new AgentRuntimeError(
        "This execution is stopping or requires recovery.",
        "RECOVERY_REQUIRED",
        409,
      );
    if (
      session.status === "waiting_input" &&
      interactionService.pending(sessionId) &&
      !interactionService.ready(sessionId)
    )
      return;
    if (
      session.sessionMetadata?.runtimeControl ||
      profileService.getForSession(session).executionHost === "embedded"
    ) {
      throw new AgentRuntimeError(
        "This session requires recovery through its owning host.",
        "RECOVERY_REQUIRED",
        409,
      );
    }
    const runId =
      owner?.runId ??
      session.activeRunId ??
      agentRuntimeStore
        .listRuns(sessionId)
        .find((run) =>
          ["waiting_permission", "waiting_input"].includes(run.status),
        )?.id;
    if (!runId)
      throw new AgentRuntimeError(
        "There is no pending Run to resume.",
        "NOT_RESUMABLE",
        409,
      );
    const { permissionTier, permissionOverrides, ...resumeInput } = input;
    if (permissionTier !== undefined || permissionOverrides !== undefined) {
      validateBackendTurnInput(resolveSessionBackend(sessionId).id, input);
      applySessionPermissionUpdate(sessionId, {
        permissionTier,
        permissionOverrides,
      });
    }
    // A delayed resume must not replay an older mode over a newer session setting.
    if (owner) {
      this.pendingResumes.set(sessionId, resumeInput);
      return;
    }
    this.launch(sessionId, runId, "resume", resumeInput);
  }

  /** Start one queued turn only after the previous conversation work has settled. */
  dispatchQueuedInput(sessionId: string): boolean {
    if (this.isActive(sessionId)) return false;
    try {
      const accepted = getRawSqlite().transaction(() => {
        const session = agentRuntimeStore.getSession(sessionId);
        const work = workStore.current(sessionId);
        const latestRun = agentRuntimeStore.listRuns(sessionId)[0];
        if (
          session.status !== "completed" ||
          session.activeRunId ||
          session.parentSessionId ||
          session.sessionMetadata?.runtimeControl ||
          latestRun?.status !== "completed" ||
          // A settled round handoff stays reserved for the goal continuation;
          // once no continuation applies (e.g. the goal finished), drain the queue.
          (latestRun.stopReason === "round_yielded" &&
            goalContinuationInput(sessionId, latestRun.id) !== null) ||
          (work && work.status !== "completed") ||
          interactionService.pending(sessionId)
        )
          return null;
        const forcedId = inputQueueService.getForceInjectId(sessionId);
        const item =
          inputQueueService
            .list(sessionId)
            .find((item) => item.id === forcedId) ??
          inputQueueService.peek(sessionId);
        if (!item) return null;
        const accepted = acceptRuntimeRun(
          sessionId,
          {
            message: item.message,
            contentParts: item.contentParts,
            references: item.references,
            referenceContext: item.referenceContext,
            model: item.model ?? undefined,
            reasoningEffort: item.reasoningEffort,
          },
          `input-queue:${item.id}`,
        );
        inputQueueService.take(sessionId, item.id);
        if (forcedId) inputQueueService.clearForceInject(sessionId);
        return accepted;
      })();
      if (!accepted) return false;
      if (!accepted.reused) {
        const runtime = accepted.run.metadata.runtime as AcceptedRuntimeInput;
        this.launch(sessionId, accepted.run.id, "turn", {
          ...runtime.input,
          acceptedRunId: accepted.run.id,
        });
      }
      return true;
    } catch (error) {
      // Admission and removal share a transaction: a rejected turn stays queued.
      logger.warn(
        { sessionId, error },
        "[run-coordinator] queued input could not be started",
      );
      return false;
    }
  }

  private launch(
    sessionId: string,
    runId: string,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
  ): void {
    const context: RuntimeExecutionContext = {
      runId,
      sessionId,
      epoch: randomUUID(),
      hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
    };
    const run = agentRuntimeStore.getRun(runId);
    agentRuntimeStore.updateRun(runId, {
      metadata: {
        ...run.metadata,
        executionLease: { ...context, closed: false },
      },
    });
    input = { ...input, executionContext: context };
    const owner: Owner = {
      context,
      runId,
      controller: new AbortController(),
      stopping: false,
      task: Promise.resolve(),
    };
    this.owners.set(sessionId, owner);
    owner.task = Promise.resolve()
      .then(() => this.drive(sessionId, owner, mode, input))
      .catch((error) =>
        this.quarantinePersistenceFailure(sessionId, owner, error),
      );
  }

  private async quarantinePersistenceFailure(
    sessionId: string,
    owner: Owner,
    error: unknown,
  ): Promise<void> {
    if (this.owners.get(sessionId) !== owner) return;
    owner.stopping = true;
    owner.stopFailed = true;
    this.pendingResumes.delete(sessionId);
    owner.controller.abort();
    let reason = `Runtime could not persist the execution outcome: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(
      { sessionId, runId: owner.runId, error },
      "[run-coordinator] persistence failure requires recovery",
    );
    const markUnconfirmed = () => {
      try {
        agentRuntimeStore.updateSessionMetadata(sessionId, {
          runtimeControl: { state: "unconfirmed", runId: owner.runId, reason },
        });
      } catch (writeError) {
        logger.error(
          { sessionId, writeError },
          "[run-coordinator] recovery block retained in memory; persistence is unavailable",
        );
      }
    };
    markUnconfirmed();
    try {
      await withDeadline(
        this.driver.interrupt(sessionId, reason),
        10_000,
        "Execution shutdown could not be confirmed.",
      );
    } catch (stopError) {
      reason += ` ${stopError instanceof Error ? stopError.message : String(stopError)}`;
      markUnconfirmed();
    }
  }

  private submitGoalContinuation(
    sessionId: string,
    previousRunId: string,
    continuation: StreamTurnRequest,
  ): void {
    const forceId = inputQueueService.getForceInjectId(sessionId);
    const forced = forceId
      ? inputQueueService.list(sessionId).find((item) => item.id === forceId)
      : undefined;
    if (forceId && !forced) inputQueueService.clearForceInject(sessionId);

    const input: StreamTurnRequest = forced
      ? {
          ...continuation,
          message: forced.message,
          messageSource: undefined,
          contentParts: forced.contentParts,
          references: forced.references,
          referenceContext: forced.referenceContext,
          model: forced.model ?? continuation.model,
          reasoningEffort:
            forced.reasoningEffort ?? continuation.reasoningEffort,
        }
      : continuation;
    const requestId = forced
      ? `goal-force-input:${forced.id}`
      : `goal-continuation:${previousRunId}`;

    const accepted = forced
      ? getRawSqlite().transaction(() => {
          const next = this.acceptRun(sessionId, input, requestId, "continue");
          const taken = inputQueueService.take(sessionId, forced.id);
          if (!taken) {
            throw new AgentRuntimeError(
              "The forced input changed before it could be continued.",
              "INPUT_QUEUE_CHANGED",
              409,
            );
          }
          inputQueueService.clearForceInject(sessionId);
          return next;
        })()
      : this.acceptRun(sessionId, input, requestId, "continue");
    this.launchAccepted(sessionId, accepted, "continue");
  }

  private async drive(
    sessionId: string,
    owner: Owner,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
  ): Promise<void> {
    const writer = new RuntimeStreamWriter(sessionId, owner.runId, () =>
      this.ownsLease(owner),
    );
    const record = (chunk: AgentRunStreamChunk) => writer.write(chunk);
    const flush = () => writer.flush();
    let settledNormally = false;
    try {
      if (owner.controller.signal.aborted)
        throw new Error("Execution stopped before launch.");
      for await (const chunk of withinExecutionContext(
        owner.context,
        this.driver.execute(sessionId, mode, input, owner.controller.signal),
      ))
        record(chunk);
      flush();
      const run = agentRuntimeStore.getRun(owner.runId);
      if (run.status === "queued" || run.status === "running") {
        throw new Error("Backend ended without settling its Run.");
      }
      settledNormally = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { sessionId, runId: owner.runId, error: message },
        "[run-coordinator] execution ended with an error",
      );
      if (!this.ownsLease(owner)) return;
      flush();
      const run = agentRuntimeStore.getRun(owner.runId);
      if (!["completed", "cancelled", "interrupted"].includes(run.status)) {
        const failed = agentRuntimeStore.updateRun(run.id, {
          status: owner.controller.signal.aborted ? "interrupted" : "failed",
          completedAt: nowIso(),
          stopReason: message,
        });
        const session = agentRuntimeStore.getSession(sessionId);
        if (session.activeRunId === run.id)
          agentRuntimeStore.updateSession(sessionId, {
            status: normalizeAgentSessionStatus(failed.status),
            activeRunId: null,
            blockedReason: message,
            updatedAt: nowIso(),
          });
        record({ type: "run_failed", run: failed, error: message });
      }
      record({ type: "done", sessionId, runId: run.id });
    } finally {
      const ownsLease = this.ownsLease(owner);
      if (!ownsLease) writer.abandon();
      if (ownsLease) {
        writer.finish();
        const run = agentRuntimeStore.getRun(owner.runId);
        agentRuntimeStore.updateRun(run.id, {
          metadata: {
            ...run.metadata,
            executionLease: { ...owner.context, closed: true },
          },
        });
      }
      if (!owner.stopping && this.owners.get(sessionId) === owner)
        this.owners.delete(sessionId);
      emitRuntimeBusEvent({ type: "session_checkpoint_changed", sessionId });
      const pending = this.pendingResumes.get(sessionId);
      this.pendingResumes.delete(sessionId);
      if (pending && !owner.stopping) {
        try {
          this.resume(sessionId, pending);
        } catch (error) {
          logger.warn(
            { sessionId, error },
            "[run-coordinator] resume was no longer applicable",
          );
        }
      } else if (
        settledNormally &&
        ownsLease &&
        !owner.stopping &&
        !owner.controller.signal.aborted &&
        !this.isActive(sessionId)
      ) {
        try {
          const continuation = goalContinuationInput(sessionId, owner.runId);
          if (continuation)
            this.submitGoalContinuation(sessionId, owner.runId, continuation);
          else this.dispatchQueuedInput(sessionId);
        } catch (error) {
          logger.warn(
            { sessionId, runId: owner.runId, error },
            "[run-coordinator] goal handoff could not be continued",
          );
        }
      }
    }
  }

  private ownsLease(owner: Owner): boolean {
    if (!owner.context) return true;
    const run = agentRuntimeStore.getRun(owner.runId);
    return (
      (run.metadata.executionLease as { epoch?: string } | undefined)?.epoch ===
      owner.context.epoch
    );
  }

  async interrupt(
    sessionId: string,
    reason: string,
    finalize?: () => void,
    expectedRunId?: string,
  ): Promise<void> {
    let owner = this.owners.get(sessionId);
    const session = agentRuntimeStore.getSession(sessionId);
    if (profileService.getForSession(session).executionHost === "embedded")
      throw new AgentRuntimeError(
        "Use the embedded job’s controls to stop this session.",
        "EMBEDDED_HOST_REQUIRED",
        409,
      );
    const currentRunId =
      owner?.runId ||
      session.activeRunId ||
      agentRuntimeStore.listRuns(sessionId)[0]?.id;
    if (expectedRunId && currentRunId !== expectedRunId)
      throw new AgentRuntimeError(
        "The active Run changed; this control request is stale.",
        "RUN_CHANGED",
        409,
      );
    if (owner?.stopTask) {
      if (finalize) owner.finalizers!.push(finalize);
      return owner.stopTask;
    }
    if (!owner) {
      owner = {
        runId: currentRunId ?? "",
        controller: new AbortController(),
        stopping: true,
        task: Promise.resolve(),
      };
      this.owners.set(sessionId, owner);
    }
    const stopping = owner;
    stopping.stopping = true;
    stopping.finalizers = finalize ? [finalize] : [];
    agentRuntimeStore.updateSessionMetadata(sessionId, {
      runtimeControl: { state: "stopping", runId: stopping.runId, reason },
    });
    const descendants = agentRuntimeStore
      .listSessionTree(sessionId)
      .slice(1)
      .filter(
        (child) =>
          child.activeRunId ||
          child.sessionMetadata?.runtimeControl ||
          [
            "queued",
            "running",
            "waiting_permission",
            "waiting_input",
            "interrupted",
            "cancelled",
          ].includes(child.status),
      );
    const descendantOwners = descendants.flatMap((child) => {
      const childOwner = this.owners.get(child.id);
      return childOwner ? [{ id: child.id, owner: childOwner }] : [];
    });
    // Fence every descendant before aborting anything: neither queued delegates
    // nor delayed permission replies may restart work while shutdown is pending.
    for (const child of descendants) {
      this.pendingResumes.delete(child.id);
      agentRuntimeStore.updateSessionMetadata(child.id, {
        runtimeControl: { state: "stopping", runId: child.activeRunId, reason },
      });
    }
    for (const child of descendantOwners) {
      child.owner.stopping = true;
      child.owner.controller.abort(new Error(reason));
    }
    this.pendingResumes.delete(sessionId);
    this.controlEvent(sessionId, stopping.runId, reason);
    stopping.controller.abort(new Error(reason));
    stopping.stopTask = (async () => {
      try {
        await this.driver.interrupt(sessionId, reason);
        await stopping.task;
        await Promise.all(
          descendantOwners.map(
            (child) => child.owner.stopTask ?? child.owner.task,
          ),
        );
        for (const action of stopping.finalizers!) action();
        for (const child of descendants) {
          if (agentRuntimeStore.tryGetSession(child.id))
            agentRuntimeStore.updateSessionMetadata(child.id, {
              runtimeControl: null,
            });
        }
        for (const child of descendantOwners)
          if (this.owners.get(child.id) === child.owner)
            this.owners.delete(child.id);
        if (agentRuntimeStore.tryGetSession(sessionId)) {
          agentRuntimeStore.updateSessionMetadata(sessionId, {
            runtimeControl: null,
          });
          this.controlEvent(
            sessionId,
            stopping.runId,
            "Execution shutdown confirmed.",
          );
        }
        if (this.owners.get(sessionId) === stopping)
          this.owners.delete(sessionId);
      } catch (error) {
        stopping.stopFailed = true;
        if (agentRuntimeStore.tryGetSession(sessionId)) {
          agentRuntimeStore.updateSessionMetadata(sessionId, {
            runtimeControl: {
              state: "unconfirmed",
              runId: stopping.runId,
              reason:
                error instanceof Error
                  ? error.message
                  : "Execution shutdown could not be confirmed.",
            },
          });
          this.controlEvent(
            sessionId,
            stopping.runId,
            "Execution shutdown could not be confirmed.",
          );
        }
        throw error;
      }
    })();
    return stopping.stopTask;
  }

  private controlEvent(
    sessionId: string,
    runId: string,
    summary: string,
  ): void {
    if (!runId) return;
    const event = agentEventService.append({
      sessionId,
      type: "progress_updated",
      summary,
      payload: { runId },
      visibility: "internal",
    });
    runtimeJournal.append(sessionId, runId, { type: "event", event });
  }

  activeSessionIds(): string[] {
    return [...this.owners.keys()];
  }

  async reconcileFailedStop(sessionId: string): Promise<void> {
    const owner = this.owners.get(sessionId);
    if (!owner) return;
    if (!owner.stopping || !owner.stopFailed)
      throw new AgentRuntimeError(
        "Execution has not finished stopping.",
        "SESSION_BUSY",
        409,
      );
    owner.stopTask = undefined;
    owner.stopFailed = false;
    owner.finalizers = [];
    await this.interrupt(sessionId, "Recovery rechecked the owned processes.");
  }

  async waitForIdle(): Promise<void> {
    while (this.owners.size) {
      const owners = [...this.owners.values()];
      if (owners.some((owner) => owner.stopFailed && !owner.stopTask)) {
        throw new AgentRuntimeError(
          "An execution requires recovery before Runtime can become idle.",
          "RECOVERY_REQUIRED",
          409,
        );
      }
      await Promise.all(owners.map((owner) => owner.stopTask ?? owner.task));
    }
  }

  async *observeRun(
    sessionId: string,
    runId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeStreamRecord> {
    if (agentRuntimeStore.getRun(runId).sessionId !== sessionId)
      throw new AgentRuntimeError(
        "Run belongs to another session.",
        "NOT_FOUND",
        404,
      );
    let cursor = after;
    while (!signal?.aborted) {
      const records = runtimeJournal.read(sessionId, cursor, 256, runId);
      for (const record of records) {
        if (signal?.aborted) return;
        cursor = record.sequence;
        yield record;
        if (record.chunk.type === "done") return;
      }
      if (!records.length) {
        const run = agentRuntimeStore.getRun(runId);
        if (
          !this.isActive(sessionId) &&
          !["queued", "running"].includes(run.status)
        )
          return;
        await runtimeJournal.wait(sessionId, signal);
      }
    }
  }
}

export const runCoordinator = new RunCoordinator();
