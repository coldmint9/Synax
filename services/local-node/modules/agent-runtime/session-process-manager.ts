import { StreamQueue } from "./stream-queue.js";
import {
  prepareOwnedProcess,
  recordOwnedPid,
  releaseOwnedProcess,
  waitForAuthoritativeLease,
  hasBackgroundProcesses,
  hasLocalBackgroundProcesses,
  listOwnedProcesses,
  stopRecordedProcess,
} from "./process-ownership.js";
import { WorkerAdmission } from "./worker-admission.js";
import type { WorkerLease } from "./worker-types.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resourceRequest, type OverdueResource } from "./resource-admission.js";
import { outsideExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { businessStore } from "../../infrastructure/persistence/business-store.js";
import { skillSourceService } from "../skills/skill-source-service.js";
import fs from "node:fs";
import path from "node:path";
import { runtimeAsset } from "../../infrastructure/runtime/runtime-paths.js";
import {
  isAgentSessionChildMessage,
  forwardChunkToLiveBus,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import {
  MAX_AGENT_SESSION_PROCESSES,
  AGENT_SESSION_CHILD_READY_TIMEOUT_MS,
  agentSessionsRunInProcess,
} from "../../infrastructure/runtime/env.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { nowIso } from "./runtime-ids.js";
import { patchRuntime } from "./sidecar/runtime-repository.js";
import type { AgentRunStreamChunk, StreamTurnRequest } from "./contracts.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  assertSessionCanCompact,
  compactSessionContextWithLlm,
  type ContextCompactionResult,
} from "./manual-context-compaction.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { runtimeBus, type RuntimeBusEvent } from "./runtime-bus.js";
import { setRuntimeWorkerNotifier } from "./runtime-bus-bridge.js";
import { finalizeStoppedSessions } from "./stopped-session-cleanup.js";
import {
  ensureSessionTitleGenerated,
  maybeScheduleSessionTitleFromStreamChunk,
} from "./session-title-service.js";
import { syncWorkerSessionBinding } from "./session-binding-sync.js";

const ACTIVE_SESSION_WAIT_MS = 25;
const ACTIVE_SESSION_TIMEOUT_MS = 5_000;
const CHILD_READY_TIMEOUT_MS = AGENT_SESSION_CHILD_READY_TIMEOUT_MS;
const CONTEXT_COMPACTION_TIMEOUT_MS = 5 * 60_000;
let preparingWorkerMetadata: Promise<void> | undefined;

function prepareWorkerMetadata(): Promise<void> {
  if (!process.env.SYNAX_RUNTIME_PROVIDER_PORT) return Promise.resolve();
  // Default sources are create-if-missing. Seed once in the host before fork,
  // so simultaneous cold workers never race to create the same metadata key.
  return preparingWorkerMetadata ??= outsideExecutionContext(async () => {
    await businessStore.refresh(["skill-sources"]);
    skillSourceService.ensureDefaultSources();
    await businessStore.flush(["skill-sources"]);
  }).finally(() => { preparingWorkerMetadata = undefined; });
}

interface ActiveStream {
  streamId: string;
  queue: StreamQueue;
}

interface ContextCompactionRequest {
  requestId: string;
  resolve: (result: ContextCompactionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionChildState {
  lease: WorkerLease;
  ownerId: string;
  sessionId: string;
  child: ChildProcess;
  streams: Map<string, ActiveStream>;
  compactions: Map<string, ContextCompactionRequest>;
}

function resolveAgentSessionRunnerPath(): string {
  const runner = runtimeAsset(
    import.meta.url,
    "../../../worker/jobs/agent-session-runner.ts",
    "workers/agent-session-runner.cjs",
  );
  if (!fs.existsSync(runner))
    throw new Error(
      "The agent-session-runner executable is missing from this Runtime build.",
    );
  return runner;
}

export class SessionProcessManager {
  private readonly streamControllers = new Map<string, AbortController>();
  private readonly parkedChildren = new WeakSet<ChildProcess>();
  private readonly admission = new WorkerAdmission(MAX_AGENT_SESSION_PROCESSES);
  private readonly pendingStarts = this.admission.queue;
  private readonly exitReconciliations = new Set<string>();
  assertCanQueueChild(): void {
    if (this.pendingStarts.length >= 128) throw new AgentRuntimeError("Session worker queue is full.", "SESSION_LIMIT", 429);
  }
  private pendingStartEligible(id: string): boolean {
    return !this.exitReconciliations.has(id) && ![...this.resourceCleanup.values()].some(ids => ids.includes(id)) && ![...this.terminatingChildren.values()].includes(id);
  }
  private resourceWatch?: ReturnType<typeof setInterval>;
  private checkingResources = false;
  private readonly resourceCleanup = new Map<string, string[]>();

  private watchResources(): void {
    if (this.resourceWatch || !process.env.SYNAX_RUNTIME_PROVIDER_PORT) return;
    this.resourceWatch = setInterval(() => {
      if (this.checkingResources) return;
      this.checkingResources = true;
      void outsideExecutionContext(() => this.reconcileResources()).catch(error => logger.warn({ error: String(error) }, "Resource supervisor check failed"))
        .finally(() => { this.checkingResources = false; });
    }, 2_000);
    this.resourceWatch.unref();
  }

  private async reconcileResources(): Promise<void> {
    for (const state of this.children.values()) {
      if (state.child.connected) state.child.send?.({ type: "stream:yield-request", requested: this.pendingStarts.length > 0 });
    }
    const { requests } = await resourceRequest<{ requests: OverdueResource[] }>("overdue", {});
    for (const request of requests) {
      const state = [...this.children.values()].find(child => child.ownerId === request.ownerId);
      if (state) {
        logger.warn({ sessionId: request.sessionId, runId: request.runId,
          ownerId: request.ownerId, resourceId: request.id, resource: request.resource, timeoutMs: request.timeoutMs },
        "[agent-session] tool cleanup grace expired; terminating worker");
        this.releaseChild(state.sessionId, "Tool execution exceeded its deadline or stopped responding.", { pushStreamError: true });
      }
    }
    for (const [ownerId, sessionIds] of this.resourceCleanup) {
      const owner = await resourceRequest<{ active: boolean }>("owner", { ownerId });
      if (!owner.active) { this.resourceCleanup.delete(ownerId); continue; }
      let confirmed = true;
      for (const sessionId of sessionIds) {
        const records = await listOwnedProcesses(sessionId);
        for (const record of records) {
          if (record.state === "active" && !(await stopRecordedProcess(record))) confirmed = false;
        }
      }
      if (confirmed) {
        await resourceRequest("release-owner", { ownerId });
        this.resourceCleanup.delete(ownerId);
      }
    }
    if (!this.children.size && !this.terminatingChildren.size && !this.resourceCleanup.size) {
      clearInterval(this.resourceWatch); this.resourceWatch = undefined;
    }
  }
  private readonly children = new Map<string, SessionChildState>();
  private readonly activeMainStreams = new Set<string>();
  /** Sessions whose children we are intentionally tearing down (idle release / interrupt). */
  private readonly releasingChildren = new Set<string>();
  private readonly terminatingChildren = new Map<ChildProcess, string>();
  private readonly idleChildren = new WeakSet<ChildProcess>();
  private readonly pendingCompactions = new Set<string>();
  private readonly compactionControllers = new Map<string, AbortController>();

  notifyRuntimeEvent(event: RuntimeBusEvent): void {
    if (event.type !== "subagent_state_changed") return;
    const child = this.children.get(event.sessionId)?.child;
    if (!child?.connected) return;
    // A notification is only a wake-up hint. Readers rehydrate durable state.
    child.send({ type: "runtime:notify", event }, error => {
      if (error) logger.warn({ sessionId: event.sessionId, error }, "Subagent wake-up transport closed");
    });
  }

  isSessionStreaming(sessionId: string): boolean {
    return this.activeMainStreams.has(sessionId);
  }

  canSpawnChild(sessionId?: string): boolean {
    if (sessionId && !this.pendingStartEligible(sessionId)) return false;
    const existing = sessionId ? this.children.get(sessionId) : undefined;
    // A connected process can still be starting or releasing. Idle ownership
    // and global physical capacity are separate admission decisions.
    if (existing?.child.connected && !existing.lease) return true;
    return this.admission.canStart(sessionId, this.countChildren(), id => this.pendingStartEligible(id));
  }

  private evictIdleWorkers(pressure = false): void {
    for (const lease of this.admission.evictions(pressure))
      this.releaseChild(lease.sessionId, "Idle worker released by admission.", { idle: true });
  }

  private retainOrRelease(state: SessionChildState, evictable = true): void {
    if (state.lease) {
      state.lease.evictable = evictable;
      this.admission.lifecycle.idle(state.lease);
      this.evictIdleWorkers(this.pendingStarts.length > 0);
    } else this.releaseChild(state.sessionId, "Agent session stream finished.", { idle: true });
    this.pendingStarts.notify();
  }

  assertCanSpawnChild(sessionId?: string): void {
    if (this.canSpawnChild(sessionId)) return;
    throw new AgentRuntimeError(
      `Too many active agent session processes (max ${MAX_AGENT_SESSION_PROCESSES}).`,
      "SESSION_LIMIT",
      429,
    );
  }

  async *streamSession(
    sessionId: string,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AgentRunStreamChunk> {
    if (this.activeMainStreams.has(sessionId) || this.pendingCompactions.has(sessionId)) {
      throw new AgentRuntimeError(
        "Session already has an active run.",
        "SESSION_BUSY",
        409,
      );
    }

    this.assertCanQueueChild();
    const controller = new AbortController();
    abortSignal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;
    this.streamControllers.set(sessionId, controller);
    this.activeMainStreams.add(sessionId);
    const streamId = randomUUID();
    const queue = new StreamQueue();
    let childState: SessionChildState;
    let onAbort: (() => void) | undefined;

    try {
      this.pendingStarts.push(sessionId);
      const queuedAt = nowIso();
      const deadline = Date.now() + 300_000;
      if (!this.canSpawnChild(sessionId) && input.acceptedRunId) {
        const run = agentRuntimeStore.updateRun(input.acceptedRunId, {
          execution: { phase: "queued_resources", resource: "worker", queuedAt },
        });
        yield { type: "execution_status", runId: run.id, execution: run.execution! };
      }
      if (!this.canSpawnChild(sessionId)) for (const state of this.children.values()) if (state.child.connected)
        state.child.send?.({ type: "stream:yield-request", requested: true });
      if (!this.canSpawnChild(sessionId)) this.evictIdleWorkers(true);
      while (!this.canSpawnChild(sessionId)) {
        abortSignal?.throwIfAborted();
        if (Date.now() >= deadline) throw new AgentRuntimeError("Timed out waiting for a session worker.", "SESSION_QUEUE_TIMEOUT", 429);
        await this.pendingStarts.wait(abortSignal);
      }
      abortSignal?.throwIfAborted();
      childState = await this.ensureChild(sessionId, abortSignal);
      this.pendingStarts.remove(sessionId);
      childState.streams.set(streamId, { streamId, queue });

      onAbort = () => {
        childState.child.send?.({
          type: "stream:cancel",
          streamId,
          reason: "Client disconnected.",
        });
        queue.close();
      };

      if (abortSignal?.aborted) {
        onAbort();
      } else {
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      }

      childState.child.send?.({
        type: "stream:start",
        flowControl: "byte-credit-v1",
        streamId,
        mode,
        input,
      });

      while (true) {
        const item = await queue.next();
        if (item.kind === "chunk") {
          yield item.chunk;
          continue;
        }
        if (item.kind === "parked") {
          childState.streams.delete(streamId);
          this.parkedChildren.add(childState.child);
          this.releaseChild(sessionId, "Yielding this worker at a completed step.", { idle: true });
          this.activeMainStreams.add(sessionId);
          this.pendingStarts.push(sessionId);
          await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
          const runId = input.acceptedRunId ?? agentRuntimeStore.getSession(sessionId).activeRunId;
          if (!runId) throw new AgentRuntimeError("Parked execution no longer exists.", "EXECUTION_SUPERSEDED", 409);
          const parked = agentRuntimeStore.updateRun(runId, { execution: { phase: "queued_resources", resource: "worker", queuedAt: nowIso() } });
          yield { type: "execution_status", runId, execution: parked.execution! };
          const resumeDeadline = Date.now() + 300_000;
          while (!this.canSpawnChild(sessionId)) {
            if (Date.now() >= resumeDeadline) throw new AgentRuntimeError("Timed out waiting to resume a session worker.", "SESSION_QUEUE_TIMEOUT", 429);
            await this.pendingStarts.wait(abortSignal);
          }
          abortSignal?.throwIfAborted();
          childState = await this.ensureChild(sessionId, abortSignal);
          this.pendingStarts.remove(sessionId);
          childState.streams.set(streamId, { streamId, queue });
          input = { ...input, acceptedRunId: runId, resumeExecution: true };
          childState.child.send?.({ type: "stream:start", flowControl: "byte-credit-v1", streamId, mode: "resume", input });
          continue;
        }
        if (item.kind === "error") {
          throw new AgentRuntimeError(item.error, item.code ?? "STREAM_ERROR", item.code === "EXECUTION_SUPERSEDED" ? 409 : 500);
        }
        // The worker flushes its checkpoint before stream:done. Refresh the
        // host cache before idle release so exit cleanup preserves a waiting
        // run instead of interrupting the stale running projection.
        await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
        break;
      }
    } finally {
      queue.dispose();
      this.pendingStarts.remove(sessionId);
      this.streamControllers.delete(sessionId);
      if (onAbort) {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      const state = this.children.get(sessionId);
      state?.streams.delete(streamId);
      this.activeMainStreams.delete(sessionId);
      // Admission owns idle retention and pressure eviction after execution ends.
      if (
        state &&
        state.streams.size === 0 &&
        state.compactions.size === 0
      ) {
        this.retainOrRelease(state, !(await hasBackgroundProcesses(sessionId, true)));
      }
    }
  }

  async beginContextCompaction(sessionId: string): Promise<{ accepted: true; status: "compacting" }> {
    if (this.activeMainStreams.has(sessionId))
      throw new AgentRuntimeError("Wait for the current run to finish before compacting context.", "SESSION_BUSY", 409);
    assertSessionCanCompact(sessionId);
    if (this.pendingCompactions.has(sessionId))
      throw new AgentRuntimeError("Context compaction is already running.", "COMPACTION_BUSY", 409);
    const ownerId = randomUUID();
    this.pendingCompactions.add(sessionId);
    try {
      // A completed run can still be releasing its worker. Wait for that
      // teardown instead of reporting a misleading capacity error to the UI.
      const teardownDeadline = Date.now() + 10_000;
      while (!this.pendingStartEligible(sessionId)) {
        if (Date.now() >= teardownDeadline)
          throw new AgentRuntimeError("The previous worker is still releasing resources.", "SESSION_BUSY", 409);
        await delay(50);
      }
      this.assertCanSpawnChild(sessionId);
      await agentRuntimeStore.flushSession(sessionId);
      await patchRuntime(sessionId, "compaction_lock", { ownerId, hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}` }, `compaction-lock:${ownerId}`);
    } catch (error) {
      this.pendingCompactions.delete(sessionId);
      throw error;
    }
    const controller = new AbortController();
    this.compactionControllers.set(sessionId, controller);
    void this.executeContextCompaction(sessionId, ownerId, controller).catch(error => {
      logger.error({ sessionId, error: String(error) }, "Context compaction cleanup requires recovery");
    });
    return { accepted: true, status: "compacting" };
  }

  private async executeContextCompaction(sessionId: string, ownerId: string, controller: AbortController): Promise<void> {
    let request: ContextCompactionRequest | undefined;
    const timer = setTimeout(() => controller.abort(new Error("Context compaction timed out.")), CONTEXT_COMPACTION_TIMEOUT_MS);
    const cancel = () => {
      this.children.get(sessionId)?.child.send?.({ type: "context:cancel", requestId: ownerId });
      request?.reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Context compaction cancelled."));
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      let result: ContextCompactionResult;
      if (agentSessionsRunInProcess()) {
        result = await compactSessionContextWithLlm(sessionId, controller.signal, ownerId);
      } else {
        const state = await this.ensureChild(sessionId);
        controller.signal.throwIfAborted();
        result = await new Promise<ContextCompactionResult>((resolve, reject) => {
          request = { requestId: ownerId, resolve, reject, timer };
          state.compactions.set(ownerId, request);
          state.child.send?.({ type: "context:compact", requestId: ownerId }, error => { if (error) reject(error); });
        });
      }
      // No eligible completed step means no special run was needed. Still
      // settle the accepted UI operation instead of leaving its spinner live.
      if (!result.compacted) sessionLiveBus.emit(sessionId, { type: "context_compacted", stepId: "",
        originalTokens: result.originalTokens, compressedTokens: result.tokens, messageCount: result.messageCount });
    } catch (error) {
      logger.error({ sessionId, error: String(error) }, "[context-compaction] failed");
      sessionLiveBus.emit(sessionId, { type: "context_compaction_failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      // The durable owner is revoked before another run can be admitted.
      // A late worker result will fail its owner check in context_commit.
      await patchRuntime(sessionId, "compaction_unlock", { ownerId }, `compaction-unlock:${ownerId}`);
      await (await import("./checkpoint-service.js")).recoverCheckpointHead(sessionId);
      this.pendingCompactions.delete(sessionId);
      this.compactionControllers.delete(sessionId);
      const state = this.children.get(sessionId);
      state?.compactions.delete(ownerId);
      if (state && state.streams.size === 0 && state.compactions.size === 0)
        this.retainOrRelease(state, !(await hasBackgroundProcesses(sessionId, true)));
      await agentRuntimeStore.hydrateSessionSummary(sessionId, true);
    }
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
  ): void {
    for (const sessionId of sessionIds) {
      this.compactionControllers.get(sessionId)?.abort(new Error(reason));
      this.streamControllers.get(sessionId)?.abort(new Error(reason));
      for (const [child, id] of this.terminatingChildren) {
        if (id === sessionId) this.idleChildren.delete(child);
      }
      this.releaseChild(sessionId, reason, { pushStreamError: true });
    }
  }

  private releaseChild(
    sessionId: string,
    reason: string,
    options?: { pushStreamError?: boolean; idle?: boolean },
  ): void {
    const state = this.children.get(sessionId);
    if (!state) return;

    if (state.lease) this.admission.lifecycle.release(state.lease);
    this.releasingChildren.add(sessionId);
    if (options?.idle) this.idleChildren.add(state.child);
    if (state.child.exitCode == null && state.child.signalCode == null) {
      this.terminatingChildren.set(state.child, sessionId);
      const force = setTimeout(() => {
        if (this.terminatingChildren.has(state.child))
          state.child.kill("SIGKILL");
      }, 3000);
      force.unref();
      const confirmedExit = () => {
        clearTimeout(force);
        this.terminatingChildren.delete(state.child);
        this.pendingStarts.notify();
      };
      state.child.once("exit", confirmedExit);
      state.child.once("close", confirmedExit);
    }

    if (options?.pushStreamError) {
      for (const stream of state.streams.values()) {
        stream.queue.push({ kind: "error", error: reason });
        stream.queue.close();
      }
      state.streams.clear();
    }

    if (state.child.connected) {
      state.child.send?.({ type: "session:interrupt", reason });
    }

    // Remove execution ownership; physical capacity stays occupied until exit.
    this.children.delete(sessionId);
    this.activeMainStreams.delete(sessionId);

    if (!state.child.killed) {
      state.child.kill("SIGTERM");
    }
  }

  async waitForIdleSessions(
    sessionIds: Iterable<string>,
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
    allowRetainedIdle = false,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const deadline = Date.now() + timeoutMs;
    while (
      ids.some(
        (sessionId) =>
          this.activeMainStreams.has(sessionId) ||
          this.exitReconciliations.has(sessionId) ||
          (this.children.has(sessionId) && !(allowRetainedIdle && this.admission.lifecycle.phase(sessionId) === "idle")) ||
          [...this.terminatingChildren.values()].includes(sessionId),
      )
    ) {
      if (Date.now() >= deadline) {
        throw new AgentRuntimeError(
          "Timed out while waiting for active agent runtime sessions to stop.",
          "DELETE_TIMEOUT",
          409,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ACTIVE_SESSION_WAIT_MS),
      );
    }
  }

  async waitForWorkerRelease(sessionId: string): Promise<void> {
    await this.waitForIdleSessions([sessionId], ACTIVE_SESSION_TIMEOUT_MS, true);
  }

  async interruptAndWaitForSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = [...sessionIds];
    // Delegates run inside their ancestor's worker. Interrupt only their local
    // loop and wait for acknowledgement; killing that worker would kill siblings.
    for (const id of ids) {
      if (this.children.has(id)) continue;
      const seen = new Set([id]);
      let parentId = agentRuntimeStore.tryGetSession(id)?.parentSessionId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const host = this.children.get(parentId);
        if (host) {
          if (!ids.includes(parentId))
            await this.interruptHostedSubtree(
              host.child,
              id,
              reason,
              timeoutMs,
            );
          break;
        }
        parentId = agentRuntimeStore.tryGetSession(parentId)?.parentSessionId;
      }
    }
    this.interruptSessions(ids, reason);
    await this.waitForIdleSessions(ids, timeoutMs);
  }

  private interruptHostedSubtree(
    child: ChildProcess,
    sessionId: string,
    reason: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        error ? reject(error) : resolve();
      };
      const onMessage = (message: unknown) => {
        if (
          !isAgentSessionChildMessage(message) ||
          message.type !== "session:subtree-stopped" ||
          message.requestId !== requestId ||
          message.sessionId !== sessionId
        )
          return;
        finish(
          message.error
            ? new AgentRuntimeError(message.error, "STOP_UNCONFIRMED", 409)
            : undefined,
        );
      };
      const onExit = () => finish();
      const timer = setTimeout(
        () =>
          finish(
            new AgentRuntimeError(
              "Timed out waiting for the subagent to stop.",
              "DELETE_TIMEOUT",
              409,
            ),
          ),
        timeoutMs,
      );
      child.on("message", onMessage);
      child.once("exit", onExit);
      if (!child.connected) {
        // A disconnect alone does not confirm termination. A concurrently
        // stopping host may still exit and satisfy the acknowledgement.
        if (child.exitCode != null || child.signalCode != null) onExit();
        return;
      }
      child.send(
        { type: "session:interrupt-subtree", requestId, sessionId, reason },
        (error) => {
          if (error) finish(error);
        },
      );
    });
  }

  private countChildren(): number {
    return Math.max(this.children.size + this.terminatingChildren.size, this.admission.lifecycle.physicalCount);
  }

  private async ensureChild(sessionId: string, signal?: AbortSignal): Promise<SessionChildState> {
    const existing = this.children.get(sessionId);
    if (existing && existing.child.connected) {
      if (existing.lease) this.admission.lifecycle.running(existing.lease);
      return existing;
    }
    if (existing) {
      this.releaseChild(sessionId, "Disconnected worker is being released.", { pushStreamError: true });
    }

    this.assertCanSpawnChild(sessionId);
    signal?.throwIfAborted();
    const lease = this.admission.lifecycle.start(sessionId);
    // Reservation is atomic; the next queued session can use another slot
    // while this child performs its ready handshake.
    this.pendingStarts.remove(sessionId);
    let processOwnerId: string | undefined;
    try {
      await prepareWorkerMetadata();
      signal?.throwIfAborted();
      const session = agentRuntimeStore.getSession(sessionId);
      const init: AgentSessionChildInit = {
        sessionId,
        projectId: session.projectId,
        workDir: resolveSessionWorkDir(sessionId, session.projectId),
      };

      const runnerPath = resolveAgentSessionRunnerPath();
      const isTs = runnerPath.endsWith(".ts");
      const processTicket = prepareOwnedProcess("native-agent-worker", true);
      processOwnerId = processTicket.id;
      const child = fork(runnerPath, [], {
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          SYNAX_AGENT_SESSION_CHILD: "1",
          SYNAX_PROCESS_OWNER: processTicket.id,
          SYNAX_RECORDED_START: "1",
          AGENT_SESSION_INIT: JSON.stringify(init),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: isTs ? ["--import", "tsx/esm"] : [],
        // Older @types/node releases omit this valid child-process option.
        windowsHide: true,
      } as Parameters<typeof fork>[2]);

      recordOwnedPid(processTicket.id, child.pid);
      child.once("close", () => releaseOwnedProcess(processTicket.id));
      child.once("error", () => releaseOwnedProcess(processTicket.id));
      const state: SessionChildState = {
        lease,
        ownerId: processTicket.id,
        sessionId,
        child,
        streams: new Map(),
        compactions: new Map(),
      };
      this.children.set(sessionId, state);
      this.watchResources();

      child.stdout?.on("data", (chunk: Buffer) => {
        logger.debug(
          { sessionId, chunk: chunk.toString().trimEnd() },
          "[agent-session] child stdout",
        );
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        logger.warn(
          { sessionId, chunk: chunk.toString().trimEnd() },
          "[agent-session] child stderr",
        );
      });

      child.on("message", (message: unknown) => {
        if (this.children.get(sessionId) !== state || !this.admission.lifecycle.current(lease) || lease.phase === "releasing") return;
        if (
          isAgentSessionChildMessage(message) &&
          message.type === "session:booted"
        ) {
          child.send?.({ type: "session:initialize" });
          return;
        }
        void this.handleChildMessage(sessionId, message, state).catch(error => logger.error({sessionId,error}, "Worker message handling failed"));
      });

      let exitHandled = false;
      const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exitHandled) return;
        exitHandled = true;
        this.admission.lifecycle.exited(lease);
        this.pendingStarts.notify();
        // A worker exit alone does not prove that its detached commands stopped.
        if (process.env.SYNAX_RUNTIME_PROVIDER_PORT) {
          const ids = agentRuntimeStore.tryGetSession(sessionId) ? agentRuntimeStore.listSessionTree(sessionId).map(session => session.id) : [sessionId];
          this.resourceCleanup.set(processTicket.id, ids);
        }
        const intentional = this.releasingChildren.delete(sessionId);
        if (!intentional && code !== 0 && code !== null) {
          logger.error(
            { sessionId, code, signal },
            "[agent-session] child exited abnormally",
          );
        } else if (!intentional && signal) {
          logger.warn(
            { sessionId, code, signal },
            "[agent-session] child exited by signal",
          );
        }
        const current = this.children.get(sessionId);
        const released = this.terminatingChildren.has(child);
        if (!this.parkedChildren.has(child) && (current?.child === child || (released && !current))) {
          // Descendants execute in this worker too. Its exit confirms they can
          // no longer update their own sessions, runs or steps.
          const exitingSessions = agentRuntimeStore.tryGetSession(sessionId)
            ? agentRuntimeStore.listSessionTree(sessionId)
            : [];
          const priorRuns = new Map(exitingSessions.map((session) => [session.id, session.activeRunId]));
          const ids = exitingSessions.map((session) => session.id);
          for (const id of ids) this.exitReconciliations.add(id);
          void outsideExecutionContext(async () => {
            // The worker persisted its result in another process. Refresh before
            // cleanup so a stale running cache cannot overwrite a failed run.
            // Keep replacements waiting until these writes have also settled.
            const refreshed = await Promise.allSettled(
              ids.map((id) => agentRuntimeStore.hydrateExecutionSession(id, true)),
            );
            const failure = refreshed.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            const stopped = ids.filter((id) => {
              const session = agentRuntimeStore.tryGetSession(id);
              // Admission can queue the next turn while its worker waits for
              // this cleanup; that turn does not belong to the exited process.
              if (session?.activeRunId && session.activeRunId !== priorRuns.get(id)) return false;
              // Idle waiting runs are durable continuations.
              return session && (!this.idleChildren.has(child) ||
                (session.status !== "waiting_input" && session.status !== "waiting_permission"));
            });
            finalizeStoppedSessions(stopped, `Agent session worker exited (code ${code}, signal ${signal}).`);
            const flushed = await Promise.allSettled(
              stopped.map((id) => agentRuntimeStore.flushSession(id)),
            );
            const writeFailure = flushed.find((result) => result.status === "rejected");
            if (writeFailure?.status === "rejected") throw writeFailure.reason;
          }).catch((error) => {
            logger.error(
              { sessionId, err: error },
              "[agent-session] failed to reconcile exited worker",
            );
          }).finally(() => {
            for (const id of ids) this.exitReconciliations.delete(id);
            this.admission.lifecycle.recovered(lease);
            this.pendingStarts.notify();
          });
        }
        if (this.parkedChildren.has(child) || !(current?.child === child || (released && !current)))
          this.admission.lifecycle.recovered(lease);
        if (current?.child === child) {
          for (const compaction of current.compactions.values()) {
            clearTimeout(compaction.timer);
            compaction.reject(
              new AgentRuntimeError(
                "Agent session child process exited.",
                "CHILD_EXITED",
                500,
              ),
            );
          }
          current.compactions.clear();
          this.pendingCompactions.delete(sessionId);
          for (const stream of current.streams.values()) {
            stream.queue.push({
              kind: "error",
              error: "Agent session child process exited.",
            });
            stream.queue.close();
          }
          this.children.delete(sessionId);
        }
        if (!this.parkedChildren.has(child) && (!current || current.child === child))
          this.activeMainStreams.delete(sessionId);
      };
      child.once("exit", onChildExit);
      // Spawn failures may emit error + close without exit. Close still confirms
      // there is no physical child retaining this admission slot.
      child.once("close", (code, signal) => onChildExit(code, signal));

      await Promise.all([
        this.waitForChildReady(sessionId, signal),
        waitForAuthoritativeLease(processTicket.id).then(() => {
          signal?.throwIfAborted();
          child.send?.({ type: "session:initialize" });
        }),
      ]);
      signal?.throwIfAborted();
      this.admission.lifecycle.running(lease);
      logger.info({ sessionId, pid: child.pid }, "[agent-session] child started");
      return state;
    } catch (error) {
      if (this.children.get(sessionId)?.lease === lease)
        this.releaseChild(sessionId, "Worker failed to start.", { pushStreamError: true });
      else if (lease.phase === "starting") {
        if (processOwnerId) releaseOwnedProcess(processOwnerId);
        this.admission.lifecycle.recovered(lease);
      }
      this.pendingStarts.notify();
      throw error;
    }
  }

  private waitForChildReady(sessionId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new AgentRuntimeError(
            "Agent session child failed to become ready.",
            "CHILD_READY_TIMEOUT",
            500,
          ),
        );
      }, CHILD_READY_TIMEOUT_MS);

      const onMessage = (message: unknown) => {
        if (!isAgentSessionChildMessage(message)) return;
        if (
          message.type === "session:ready" &&
          message.sessionId === sessionId
        ) {
          cleanup();
          resolve();
        }
      };

      const state = this.children.get(sessionId);
      const child = state?.child;
      if (!child) {
        clearTimeout(timeout);
        reject(
          new AgentRuntimeError(
            "Agent session child missing during ready wait.",
            "CHILD_MISSING",
            500,
          ),
        );
        return;
      }

      const onExit = () => {
        cleanup();
        reject(
          new AgentRuntimeError(
            "Agent session child exited before ready.",
            "CHILD_EXITED",
            500,
          ),
        );
      };

      const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error("Worker start cancelled.")); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        child.off("error", onError);
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };

      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async handleChildMessage(sessionId: string, message: unknown, source?: SessionChildState): Promise<void> {
    if (source && (this.children.get(sessionId) !== source || !this.admission.lifecycle.current(source.lease) || source.lease.phase === "releasing")) return;
    if (!isAgentSessionChildMessage(message)) return;

    if (message.type === "session:live") {
      sessionLiveBus.emit(message.sessionId, message.event);
      return;
    }

    if (message.type === "runtime:event") {
      // A worker switches its own checkout; mirror the binding into this
      // process's caches before clients are told to refetch.
      await syncWorkerSessionBinding(message.event);
      runtimeBus.emit(message.event);
      this.notifyRuntimeEvent(message.event);
      const owner = this.children.get(sessionId);
      if (
        message.event.type === "session_process_changed" &&
        owner?.streams.size === 0 &&
        owner.compactions.size === 0 &&
        !hasLocalBackgroundProcesses(sessionId)
      ) {
        this.releaseChild(sessionId, "All background services have exited.", { idle: true });
      }
      return;
    }

    if (message.sessionId !== sessionId) return;

    const state = this.children.get(sessionId);
    if (!state) return;

    if (
      message.type === "context:compact:done" ||
      message.type === "context:compact:error"
    ) {
      const request = state.compactions.get(message.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      state.compactions.delete(message.requestId);
      if (message.type === "context:compact:done")
        request.resolve(message.result);
      else
        request.reject(
          new AgentRuntimeError(message.error, "COMPACTION_FAILED", 500),
        );
      return;
    }

    if (message.type === "stream:reserve") {
      const stream = state.streams.get(message.streamId);
      try {
        if (!stream) throw new Error("Stream is no longer active.");
        await stream.queue.reserve(message.deliveryId, message.bytes);
        state.child.send?.({ type: "stream:credit", deliveryId: message.deliveryId });
      } catch (error) {
        if (state.child.connected) state.child.send?.({ type: "stream:credit", deliveryId: message.deliveryId, error: String(error) });
      }
      return;
    }

    if (message.type === "stream:chunk") {
      const stream = state.streams.get(message.streamId);
      if (!stream) return;
      try { stream.queue.push({ kind: "chunk", chunk: message.chunk }, message.deliveryId); }
      catch (error) {
        this.streamControllers.get(sessionId)?.abort(error);
        return;
      }
      maybeScheduleSessionTitleFromStreamChunk(sessionId, message.chunk);
      forwardChunkToLiveBus(sessionId, message.chunk);
      return;
    }

    if (message.type === "stream:done") {
      ensureSessionTitleGenerated(sessionId);
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: "done" });
      stream?.queue.close();
      return;
    }

    if (message.type === "stream:parked") {
      state.streams.get(message.streamId)?.queue.push({ kind: "parked" });
      return;
    }

    if (message.type === "stream:error") {
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: "error", error: message.error, code: message.code });
      stream?.queue.close();
    }
  }
}

export const sessionProcessManager = new SessionProcessManager();
setRuntimeWorkerNotifier(event => sessionProcessManager.notifyRuntimeEvent(event));
