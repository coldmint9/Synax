import { runtimeTransaction } from "./runtime-transaction.js";
import { randomUUID } from "node:crypto";
import {
  runWithExecutionContext,
  withinExecutionContext,
  isExecutionSuperseded,
  type RuntimeExecutionContext,
} from "../../infrastructure/runtime/execution-context.js";
import type { AgentSessionStreamMode } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { executeBackendSession } from "./backend-execution.js";
import {
  resolveSessionBackend,
  validateBackendTurnInput,
} from "./backends/backend-binding.js";
import { getBackendAdapter } from "./backends/backend-registry.js";
import type {
  AgentSession,
  AgentRun,
  AgentRunStreamChunk,
  StreamTurnRequest,
} from "./contracts.js";
import { agentEventService } from "./event-service.js";
import { goalContinuationInput } from "./goal-continuation.js";
import { inputQueueRuntime } from "./input-queue-runtime.js";
import { interactionService } from "./interaction-service.js";
import { withDeadline } from "./managed-process.js";
import { profileService } from "./profile-service.js";
import {
  acceptRuntimeRun,
  acceptRuntimeRunAuthoritative,
  type AcceptedRuntimeInput,
} from "./run-admission.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";
import { captureCompletedReply } from "./runtime-history.js";
import { runtimeJournal, type RuntimeStreamRecord } from "./runtime-journal.js";
import {
  currentRuntimeHostId,
  recoverRuntimeSession,
  restoreUnlaunchedInput,
} from "./runtime-recovery.js";
import { DurableDeltaBuffer } from "./durable-delta-buffer.js";
import { createRunRealtimeChannel, closeRunRealtimeChannel, type RunRealtimeChannel } from "./run-realtime-channel.js";
import { applySessionPermissionUpdate } from "./session-permissions.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";
import { agentRuntimeStore } from "./session-store.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
interface Owner {
  realtime?: RunRealtimeChannel;
  context?: RuntimeExecutionContext;
  runId: string;
  controller: AbortController;
  task: Promise<void>;
  stopping: boolean;
  /** Human-readable stop reason, reused by background retries. */
  reason?: string;
  stopTask?: Promise<void>;
  stopFailed?: boolean;
  finalizers?: Array<() => void | Promise<void>>;
}
/** Descendants fenced by a stop: session ids plus the owners that still hold one. */
interface StopTargets {
  ids: string[];
  owners: Array<{ id: string; owner: Owner }>;
}
/**
 * A stop whose process exit was not confirmed is retried in the background.
 * The budget is bounded: whatever is left afterwards is settled by restart
 * recovery, so no failure ever reaches the composer.
 */
const SILENT_STOP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000];
const SILENT_STOP_ATTEMPT_TIMEOUT_MS = 8_000;
interface Driver {
  execute: typeof executeBackendSession;
  interrupt: (sessionId: string, reason: string) => Promise<void>;
}
const defaultDriver: Driver = {
  execute: executeBackendSession,
  async interrupt(id, reason) {
    const results = await Promise.allSettled(
      agentRuntimeStore
        .listSessionTree(id)
        // Lifecycle cleanup also applies to archived/retired bindings.
        .map(session => getBackendAdapter("native").interrupt(session.id, reason)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
};
export class RunCoordinator {
  private readonly owners = new Map<string, Owner>();
  private readonly queueDispatches = new Map<string, Promise<boolean>>();
  private readonly pendingResumes = new Map<string, StreamTurnRequest>();
  private readonly stopRetries = new Map<string, Promise<void>>();
  constructor(private readonly driver: Driver = defaultDriver) {}
  isActive(sessionId: string): boolean {
    return this.owners.has(sessionId);
  }
  isStopping(sessionId: string): boolean {
    return Boolean(this.owners.get(sessionId)?.stopping);
  }
  private async acceptRun(
    sessionId: string,
    input: StreamTurnRequest,
    requestId: string,
    mode: AgentSessionStreamMode,
  ): ReturnType<typeof acceptRuntimeRun> {
    if (this.isActive(sessionId)) {
      const previous = agentRuntimeStore
        .listRuns(sessionId)
        .find((run) =>
          (run.metadata.runtime as { requestId?: string } | undefined)?.requestId === requestId,
        );
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
    accepted: Awaited<ReturnType<typeof acceptRuntimeRun>>,
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
  async submit(
    sessionId: string,
    input: StreamTurnRequest,
    requestId: string,
    mode: AgentSessionStreamMode = "turn",
  ) {
    const accepted = await this.acceptRun(sessionId, input, requestId, mode);
    this.launchAccepted(sessionId, accepted, mode);
    return accepted;
  }
  async submitAsync(
    sessionId: string,
    input: StreamTurnRequest,
    requestId: string,
    mode: AgentSessionStreamMode = "turn",
  ) {
    const accepted = await acceptRuntimeRunAuthoritative(
      sessionId,
      input,
      requestId,
      mode,
    );
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
  dispatchQueuedInput(sessionId: string, forced = false): Promise<boolean> {
    const pending = this.queueDispatches.get(sessionId);
    if (pending) return pending;
    const task = this.dispatchQueuedInputOnce(sessionId, forced).finally(() => {
      if (this.queueDispatches.get(sessionId) === task)
        this.queueDispatches.delete(sessionId);
    });
    this.queueDispatches.set(sessionId, task);
    return task;
  }
  private async dispatchQueuedInputOnce(
    sessionId: string,
    forced: boolean,
  ): Promise<boolean> {
    if (this.isActive(sessionId)) return false;
    try {
      const queued = await inputQueueRuntime.snapshot(sessionId);
      if (this.isActive(sessionId)) return false;
      {
        const candidate = runtimeTransaction(() => {
          const session = agentRuntimeStore.getSession(sessionId);
          const latestRun = agentRuntimeStore.listRuns(sessionId)[0];
          if (
            (!forced && session.status !== "completed") ||
            session.activeRunId ||
            session.parentSessionId ||
            session.sessionMetadata?.runtimeControl ||
            (!forced && latestRun?.status !== "completed") ||
            (!forced &&
              latestRun?.stopReason === "round_yielded" &&
              goalContinuationInput(sessionId, latestRun.id) !== null) ||
            (!forced && interactionService.pending(sessionId))
          )
            return null;
          const forcedId = queued.forceInjectItemId;
          return (
            queued.items.find((item) => item.id === forcedId) ??
            queued.items[0] ??
            null
          );
        });
        if (!candidate) return false;
        const accepted = await acceptRuntimeRunAuthoritative(
          sessionId,
          {
            message: candidate.message,
            contentParts: candidate.contentParts,
            references: candidate.references,
            referenceContext: candidate.referenceContext,
            model: candidate.model ?? undefined,
            reasoningEffort: candidate.reasoningEffort,
          },
          `input-queue:${candidate.id}`,
          "turn",
          candidate,
        );
        if (!accepted.reused) {
          const runtime = accepted.run.metadata.runtime as AcceptedRuntimeInput;
          this.launch(sessionId, accepted.run.id, "turn", {
            ...runtime.input,
            acceptedRunId: accepted.run.id,
          });
        }
        return true;
      }
    } catch (error) {
      // Admission and removal share a transaction: a rejected turn stays queued.
      logger.warn(
        { sessionId, error },
        "[run-coordinator] queued input could not be started",
      );
      return false;
    }
  }
  /**
   * Stop the current turn, then start the selected queued input immediately.
   * The queue item remains durable until the new run is admitted successfully.
   */
  async forceQueuedInput(sessionId: string, itemId: string): Promise<boolean> {
    await inputQueueRuntime.markForceInject(sessionId, itemId);
    if (this.isActive(sessionId))
      await this.interrupt(
        sessionId,
        "A queued input was forced to the front of the conversation.",
      );
    return this.dispatchQueuedInput(sessionId, true);
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
    const leasePatch = { executionLease: { ...context, closed: false } };
    // The local lease is an execution ownership guard used by the Node driver;
    // Rust persists the authoritative copy after admission/activation below.
    agentRuntimeStore.updateRun(runId, {
      metadata: { ...run.metadata, ...leasePatch },
    });
    input = { ...input, executionContext: context };
    const owner: Owner = {
      realtime: createRunRealtimeChannel(sessionId, runId),
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
      {
        sessionId,
        runId: owner.runId,
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
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
        10000,
        "Execution shutdown could not be confirmed.",
      );
      // A persistence acknowledgement can time out after the backend has
      // already unwound. Do not leave a stale recovery block in that case.
      if (this.owners.get(sessionId) === owner) {
        owner.stopFailed = false;
        agentRuntimeStore.updateSessionMetadata(sessionId, {
          runtimeControl: null,
          lastRecoveryAcknowledgedAt: nowIso(),
        });
        this.owners.delete(sessionId);
      }
    } catch (stopError) {
      reason += ` ${stopError instanceof Error ? stopError.message : String(stopError)}`;
      markUnconfirmed();
    }
  }
  private async submitGoalContinuation(
    sessionId: string,
    previousRunId: string,
    continuation: StreamTurnRequest,
  ): Promise<void> {
    const queue = await inputQueueRuntime.snapshot(sessionId);
    const forceId = queue.forceInjectItemId;
    const forced = forceId
      ? queue.items.find((item) => item.id === forceId)
      : undefined;
    if (forceId && !forced) await inputQueueRuntime.clearForceInject(sessionId);
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
    {
      const accepted = await acceptRuntimeRunAuthoritative(
        sessionId,
        input,
        requestId,
        "continue",
        forced,
      );
      this.launchAccepted(sessionId, accepted, "continue");
      return;
    }
  }
  private async drive(
    sessionId: string,
    owner: Owner,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
  ): Promise<void> {
    const buffer = new DurableDeltaBuffer(sessionId, owner.runId, () =>
      this.ownsLease(owner),
    );
    const writer = buffer.writer;
    let terminalChunk: AgentRunStreamChunk | undefined;
    const record = async (chunk: AgentRunStreamChunk) => {
      if (!this.ownsLease(owner)) return;
      // done is emitted after the durable barrier, so clients cannot mistake a
      // successful transport for a successful durable completion.
      if (chunk.type === "done") {
        await buffer.appendWithBackpressure(chunk);
        await buffer.flush();
        return;
      }
      if (chunk.type === "run_completed" || chunk.type === "run_failed") {
        agentRuntimeStore.acceptRunProjection(chunk.run);
        await buffer.appendWithBackpressure(chunk);
        await buffer.flush();
        await agentRuntimeStore.flushSession(sessionId);
        terminalChunk = chunk;
        return;
      }
      chunk = owner.realtime?.publish(chunk) ?? chunk;
      if ("run" in chunk && chunk.run)
        agentRuntimeStore.acceptRunProjection(chunk.run);
      await buffer.appendWithBackpressure(chunk, owner.controller.signal);
      if (process.env.SYNAX_DURABLE_DELTA_BUFFER === "0") {
        await agentRuntimeStore.flushSession(sessionId);
        await buffer.flush();
      }
    };
    const flush = async () => {
      await agentRuntimeStore.flushSession(sessionId);
      await buffer.flush();
    };
    let settledNormally = false;
    let leaseLost = false;
    let waiting = false;
    try {
      if (owner.controller.signal.aborted)
        throw new Error("Execution stopped before launch.");
      await agentRuntimeStore.flushSession(sessionId);
      const admittedRun = agentRuntimeStore.getRun(owner.runId);
      if (admittedRun.status === "queued") {
        await runtimeFacade.admitExecution({
          sessionId,
          run: admittedRun,
          runtime: admittedRun.metadata.runtime as AcceptedRuntimeInput,
        });
        // Mirror only after Rust has durably activated this run.
        agentRuntimeStore.updateRun(owner.runId, {
          status: "running",
          completedAt: null,
          stopReason: null,
        });
      }
      if (mode === "resume") {
        await runtimeFacade.controlCommand({ sessionId,
          requestId: `resume:${owner.runId}:${owner.context?.epoch}`,
          operation: "resume", payload: { runId: owner.runId } });
      }
      await runtimeFacade.controlCommand({ sessionId,
        requestId: `execution-open:${owner.runId}:${owner.context?.epoch}`,
        operation: "execution_open", payload: owner.context });
      for await (const chunk of withinExecutionContext(
        owner.context,
        this.driver.execute(sessionId, mode, input, owner.controller.signal),
        resolveSessionBackend(sessionId).id === "native" ? { native: true, signal: owner.controller.signal } : undefined,
      ))
        await record(chunk);
      await flush();
      await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
      const run = agentRuntimeStore.getRun(owner.runId);
      if (run.status === "queued" || run.status === "running") {
        throw new Error("Backend ended without settling its Run.");
      }
      settledNormally = true;
      waiting = ["waiting_input", "waiting_permission"].includes(run.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { sessionId, runId: owner.runId, error: message, cause: error instanceof Error ? error.cause : undefined },
        "[run-coordinator] execution ended with an error",
      );
      leaseLost = isExecutionSuperseded(error);
      if (leaseLost) {
        // A superseded owner must not write over its replacement. However an
        // unsuccessful launch with no current executor must not remain running.
        // Rust decides atomically whether this is an unowned run or a real
        // handoff; UI metadata and this process's owner map are not authority.
        try {
          await runtimeFacade.controlCommand({ sessionId,
            requestId: `execution-fail-start:${owner.runId}:${owner.context?.epoch}`,
            operation: "execution_fail_start",
            payload: { executionLease: owner.context, reason: message } });
          await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
        } catch (repairError) {
          if (!isExecutionSuperseded(repairError)) throw repairError;
        }
        return;
      }
      if (!this.ownsLease(owner)) return;
      await flush();
      await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
      const run = agentRuntimeStore.getRun(owner.runId);
      if (!["completed", "cancelled", "interrupted", "failed", "blocked"].includes(run.status)) {
        const failed = agentRuntimeStore.updateRun(run.id, {
          status: owner.controller.signal.aborted || message.includes("RUN_INTERRUPTED") ? "interrupted" : "failed",
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
        await record({ type: "run_failed", run: failed, error: message });
      }
      await record({ type: "done", sessionId, runId: run.id });
    } finally {
      try {
        let ownsLease = !leaseLost && this.ownsLease(owner);
        if (!ownsLease) writer.abandon();
        if (ownsLease) {
          await flush();
          await writer.prepareFinish();
          runWithExecutionContext(owner.context, () => writer.finish());
          await writer.settled();
          if (this.ownsLease(owner)) {
            const run = agentRuntimeStore.getRun(owner.runId);
            await runtimeFacade.finishExecution(
              sessionId,
              run,
            );
            if (run.status === "interrupted" && run.stopReason?.includes("RUN_INTERRUPTED")) {
              await runtimeFacade.sessionPatch(sessionId, `interrupted-session:${run.id}`, {
                status: "paused", activeRunId: null, pendingResumeToken: null, blockedReason: run.stopReason,
              });
            }
            if (["completed", "interrupted", "cancelled", "failed", "blocked"].includes(run.status)) {
              // Include any final partial message written after the stream drained.
              await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
              // All backends settle here, including Rust and external sessions
              // that never enter the legacy loop's checkpoint finalizer.
              try {
                await captureCompletedReply(sessionId, run.id);
              } catch (error) {
                logger.warn({ sessionId, runId: run.id, error },
                  "[run-coordinator] reply checkpoint could not be saved");
              }
            }
            // Terminal finish closes the lease in the same Rust transaction.
            // Waiting checkpoints retain the run but release this executor.
            if (["waiting_input", "waiting_permission"].includes(run.status)) {
              await runtimeFacade.controlCommand({ sessionId,
                requestId: `execution-close:${owner.runId}:${owner.context?.epoch}`,
                operation: "execution_close", payload: owner.context });
            }
          }
          ownsLease = this.ownsLease(owner);
          if (!ownsLease) writer.abandon();
        }
        if (ownsLease) {
          if (terminalChunk) owner.realtime?.publish(terminalChunk);
          if (waiting) owner.realtime?.publish({ type: "run_finished", runId: owner.runId, run: agentRuntimeStore.getRun(owner.runId) });
          else owner.realtime?.publish({ type: "done", sessionId, runId: owner.runId });
        }
        if (!owner.stopping && this.owners.get(sessionId) === owner)
          this.owners.delete(sessionId);
        emitRuntimeBusEvent({ type: "session_checkpoint_changed", sessionId });
        const pending = this.pendingResumes.get(sessionId);
        this.pendingResumes.delete(sessionId);
        if (pending && !owner.stopping && !leaseLost) {
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
          agentRuntimeStore.getRun(owner.runId).status !== "interrupted" &&
          ownsLease &&
          !owner.stopping &&
          !owner.controller.signal.aborted &&
          !this.isActive(sessionId)
        ) {
          try {
            const continuation = goalContinuationInput(sessionId, owner.runId);
            if (continuation)
              await this.submitGoalContinuation(
                sessionId,
                owner.runId,
                continuation,
              );
            else await this.dispatchQueuedInput(sessionId);
          } catch (error) {
            logger.warn(
              { sessionId, runId: owner.runId, error },
              "[run-coordinator] goal handoff could not be continued",
            );
          }
        }
      } catch (error) {
        owner.realtime?.close(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        const replacement = this.owners.get(sessionId);
        if (owner.realtime && (replacement === owner || replacement?.realtime !== owner.realtime))
          closeRunRealtimeChannel(owner.realtime, waiting);
      }
    }
  }
  private ownsLease(owner: Owner): boolean {
    if (!owner.context) return true;
    if (this.owners.get(owner.context.sessionId) !== owner) return false;
    const run = agentRuntimeStore.getRun(owner.runId);
    return (
      (
        run.metadata.executionLease as
          | {
              epoch?: string;
            }
          | undefined
      )?.epoch === owner.context.epoch
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
    // Publish the stop fence before the first await so same-turn child
    // creation and delayed resume checks observe shutdown immediately.
    agentRuntimeStore.updateSessionMetadata(sessionId, {
      runtimeControl: { state: "stopping", runId: stopping.runId, reason },
    });
    void runtimeFacade
      .controlCommand({
        sessionId,
        requestId: `stop-begin:${sessionId}:${stopping.runId}:${reason}`,
        operation: "stop_begin",
        payload: { runId: stopping.runId, reason },
      })
      .catch((error) =>
        logger.warn(
          { sessionId, error },
          "[run-coordinator] Rust stop fence could not be committed",
        ),
      );
    const descendants = this.stopDescendants(sessionId);
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
    stopping.reason = reason;
    stopping.controller.abort(new Error(reason));
    const targets: StopTargets = {
      ids: descendants.map((child) => child.id),
      owners: descendantOwners,
    };
    stopping.stopTask = this.confirmStop(sessionId, stopping, targets).catch(
      async (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "Execution shutdown could not be confirmed.";
        stopping.stopFailed = true;
        await runtimeFacade
          .controlCommand({
            sessionId,
            requestId: `stop-unconfirmed:${sessionId}:${stopping.runId}`,
            operation: "stop_unconfirmed",
            payload: { runId: stopping.runId, reason: message },
          })
          .catch(() => {});
        if (agentRuntimeStore.tryGetSession(sessionId)) {
          // The fence is an internal admission guard, not a user-facing
          // failure: it keeps the next turn out until the worker is really gone.
          agentRuntimeStore.updateSessionMetadata(sessionId, {
            runtimeControl: {
              state: "unconfirmed",
              runId: stopping.runId,
              reason: message,
            },
          });
          this.controlEvent(
            sessionId,
            stopping.runId,
            "Execution shutdown could not be confirmed.",
          );
        }
        this.scheduleSilentStopRetry(sessionId, stopping, message);
        throw error;
      },
    );
    return stopping.stopTask;
  }
  private controlEvent(
    sessionId: string,
    runId: string,
    summary: string,
  ): void {
    if (!runId) return;
    // Rust stop commands publish durable stream events. The human-readable
    // audit record is persisted in history even after finish closes the run.
    agentEventService.append({
      sessionId,
      type: "progress_updated",
      summary,
      payload: { runId },
      visibility: "internal",
    });
  }
  /**
   * Confirmation half of a stop. The caller has already published the fence and
   * aborted the work, so this only waits for the shutdown to prove itself and
   * then releases the session. Keeping it separate lets a failed foreground
   * stop be retried in the background with identical semantics.
   */
  private async confirmStop(
    sessionId: string,
    stopping: Owner,
    targets: StopTargets,
  ): Promise<void> {
    await this.driver.interrupt(
      sessionId,
      stopping.reason ?? "Execution shutdown could not be confirmed.",
    );
    await stopping.task;
    await Promise.all(
      targets.owners.map((child) => child.owner.stopTask ?? child.owner.task),
    );
    await runtimeFacade.controlCommand({
      sessionId,
      requestId: `stop-ack:${sessionId}:${stopping.runId}`,
      operation: "stop_ack",
      payload: {
        runId: stopping.runId,
        reason: "Execution shutdown confirmed.",
      },
    });
    // Finalizers mutate the projection. Run them once even when a later retry
    // is the attempt that finally succeeds.
    const finalizers = stopping.finalizers ?? [];
    stopping.finalizers = [];
    for (const action of finalizers) await action();
    for (const id of targets.ids) {
      if (agentRuntimeStore.tryGetSession(id))
        agentRuntimeStore.updateSessionMetadata(id, {
          runtimeControl: null,
        });
    }
    for (const child of targets.owners)
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
  }
  /** Descendants that still own execution state and therefore need fencing. */
  private stopDescendants(sessionId: string): AgentSession[] {
    return agentRuntimeStore
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
  }
  private stopTargets(sessionId: string): StopTargets {
    const descendants = this.stopDescendants(sessionId);
    return {
      ids: descendants.map((child) => child.id),
      owners: descendants.flatMap((child) => {
        const owner = this.owners.get(child.id);
        return owner ? [{ id: child.id, owner }] : [];
      }),
    };
  }
  /**
   * Residual cleanup is a background concern. The turn is already shown as
   * stopped, so a stop that could not confirm its process exit is retried here
   * silently: no error reaches the user, and the fence clears itself as soon as
   * the worker is gone. Restart recovery settles whatever is left.
   */
  private scheduleSilentStopRetry(
    sessionId: string,
    stopping: Owner,
    reason: string,
  ): void {
    if (this.stopRetries.has(sessionId)) return;
    const retry = (async () => {
      for (const delay of SILENT_STOP_RETRY_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        // A newer owner means the session moved on; the retry is obsolete.
        if (this.owners.get(sessionId) !== stopping) return;
        try {
          await withDeadline(
            this.confirmStop(sessionId, stopping, this.stopTargets(sessionId)),
            SILENT_STOP_ATTEMPT_TIMEOUT_MS,
            "Residual execution shutdown is still unconfirmed.",
          );
          stopping.stopFailed = false;
          logger.info(
            { sessionId, runId: stopping.runId },
            "[run-coordinator] residual execution shutdown confirmed in the background",
          );
          return;
        } catch {
          // Stay silent and keep trying inside the bounded budget.
        }
      }
      logger.warn(
        { sessionId, runId: stopping.runId, reason },
        "[run-coordinator] residual execution shutdown remains unconfirmed; restart recovery will settle it",
      );
    })().finally(() => this.stopRetries.delete(sessionId));
    this.stopRetries.set(sessionId, retry);
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
  /** Admission heals a stop fence in place instead of asking the user to retry.
   * A stop that is still in flight is left alone; admission stays fenced. */
  async reconcileFencedSession(sessionId: string): Promise<void> {
    const owner = this.owners.get(sessionId);
    if (owner) {
      if (!owner.stopping || !owner.stopFailed) return;
      await this.reconcileFailedStop(sessionId);
      return;
    }
    await recoverRuntimeSession(currentRuntimeHostId(), sessionId, true);
  }
  async waitForIdle(): Promise<void> {
    while (this.owners.size || this.queueDispatches.size) {
      const owners = [...this.owners.values()];
      if (owners.some((owner) => owner.stopFailed && !owner.stopTask)) {
        throw new AgentRuntimeError(
          "An execution requires recovery before Runtime can become idle.",
          "RECOVERY_REQUIRED",
          409,
        );
      }
      await Promise.all([
        ...owners.map((owner) => owner.stopTask ?? owner.task),
        ...this.queueDispatches.values(),
      ]);
    }
  }
  async waitForSessionIdle(sessionId: string): Promise<void> {
    while (this.owners.has(sessionId) || this.queueDispatches.has(sessionId)) {
      const owner = this.owners.get(sessionId);
      if (owner?.stopFailed && !owner.stopTask)
        throw new AgentRuntimeError(
          "An execution requires recovery before Runtime can become idle.",
          "RECOVERY_REQUIRED",
          409,
        );
      await Promise.all([
        ...(owner ? [owner.stopTask ?? owner.task] : []),
        ...(this.queueDispatches.has(sessionId)
          ? [this.queueDispatches.get(sessionId)!]
          : []),
      ]);
    }
  }
  async *observeRun(
    sessionId: string,
    runId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeStreamRecord> {
    {
      const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
      const historical = (await runtimeFacade.listRunHistory(sessionId)).some(
        (item) =>
          (
            item as {
              id?: unknown;
              sessionId?: unknown;
            }
          ).id === runId &&
          (
            item as {
              sessionId?: unknown;
            }
          ).sessionId === sessionId,
      );
      if (snapshot.run?.id !== runId && !historical)
        throw new AgentRuntimeError(
          "Run belongs to another session.",
          "NOT_FOUND",
          404,
        );
    }
    let cursor = after;
    while (!signal?.aborted) {
      const records = await runtimeJournal.readDurable(
        sessionId,
        cursor,
        256,
        runId,
      );
      for (const record of records) {
        if (signal?.aborted) return;
        cursor = record.sequence;
        yield record;
        if (record.chunk.type === "done") return;
      }
      if (!records.length) {
        {
          const snapshot =
            await runtimeFacade.uiSnapshotAuthoritative(sessionId);
          const run =
            snapshot.run?.id === runId
              ? snapshot.run
              : ((await runtimeFacade.listRunHistory(sessionId)).find(
                  (item) =>
                    (
                      item as {
                        id?: unknown;
                      }
                    ).id === runId,
                ) as AgentRun | undefined);
          if (
            !this.isActive(sessionId) &&
            run &&
            !["queued", "running"].includes(run.status)
          )
            return;
        }
        await runtimeJournal.wait(sessionId, signal);
      }
    }
  }
}
export const runCoordinator = new RunCoordinator();
