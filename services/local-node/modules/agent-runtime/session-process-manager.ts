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
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import {
  saveContextCompaction,
  type ContextCompactionState,
} from "./context-compaction-state.js";
import type { AgentRunStreamChunk, StreamTurnRequest } from "./contracts.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  assertSessionCanCompact,
  compactSessionContextWithLlm,
  type ContextCompactionResult,
} from "./manual-context-compaction.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { runtimeBus } from "./runtime-bus.js";
import { finalizeStoppedSessions } from "./stopped-session-cleanup.js";
import {
  ensureSessionTitleGenerated,
  maybeScheduleSessionTitleFromStreamChunk,
} from "./session-title-service.js";

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

type StreamQueueItem =
  | { kind: "parked" }
  | { kind: "chunk"; chunk: AgentRunStreamChunk }
  | { kind: "done" }
  | { kind: "error"; error: string; code?: string };

class StreamQueue {
  private readonly pending: StreamQueueItem[] = [];
  private resolvers: Array<(item: StreamQueueItem) => void> = [];
  private closed = false;

  push(item: StreamQueueItem): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(item);
      return;
    }
    this.pending.push(item);
  }

  async next(): Promise<StreamQueueItem> {
    const pending = this.pending.shift();
    if (pending) return pending;
    if (this.closed) return { kind: "done" };
    return new Promise<StreamQueueItem>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve({ kind: "done" });
    }
    this.resolvers = [];
  }
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
  private readonly pendingStarts: string[] = [];
  assertCanQueueChild(): void {
    if (this.pendingStarts.length >= 128) throw new AgentRuntimeError("Session worker queue is full.", "SESSION_LIMIT", 429);
  }
  private pendingStartEligible(id: string): boolean {
    return ![...this.resourceCleanup.values()].some(ids => ids.includes(id)) && ![...this.terminatingChildren.values()].includes(id);
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
      if (state) this.releaseChild(state.sessionId, "Tool execution exceeded its deadline or stopped responding.", { pushStreamError: true });
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

  isSessionStreaming(sessionId: string): boolean {
    return this.activeMainStreams.has(sessionId);
  }

  canSpawnChild(sessionId?: string): boolean {
    if (sessionId && [...this.resourceCleanup.values()].some(ids => ids.includes(sessionId))) return false;
    if (sessionId && [...this.terminatingChildren.values()].includes(sessionId))
      return false;
    if (sessionId) {
      const existing = this.children.get(sessionId);
      if (existing?.child.connected) return true;
    }
    const first = this.pendingStarts.find(id => this.pendingStartEligible(id));
    return this.countChildren() < MAX_AGENT_SESSION_PROCESSES && (!first || first === sessionId);
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
    if (this.activeMainStreams.has(sessionId)) {
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
      while (!this.canSpawnChild(sessionId)) {
        abortSignal?.throwIfAborted();
        if (Date.now() >= deadline) throw new AgentRuntimeError("Timed out waiting for a session worker.", "SESSION_QUEUE_TIMEOUT", 429);
        await delay(100, undefined, { signal: abortSignal });
      }
      abortSignal?.throwIfAborted();
      childState = await this.ensureChild(sessionId);
      const queuedIndex = this.pendingStarts.indexOf(sessionId);
      if (queuedIndex >= 0) this.pendingStarts.splice(queuedIndex, 1);
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
          await agentRuntimeStore.hydrateSession(sessionId, true);
          const runId = input.acceptedRunId ?? agentRuntimeStore.getSession(sessionId).activeRunId;
          if (!runId) throw new AgentRuntimeError("Parked execution no longer exists.", "EXECUTION_SUPERSEDED", 409);
          const parked = agentRuntimeStore.updateRun(runId, { execution: { phase: "queued_resources", resource: "worker", queuedAt: nowIso() } });
          yield { type: "execution_status", runId, execution: parked.execution! };
          const resumeDeadline = Date.now() + 300_000;
          while (!this.canSpawnChild(sessionId)) {
            if (Date.now() >= resumeDeadline) throw new AgentRuntimeError("Timed out waiting to resume a session worker.", "SESSION_QUEUE_TIMEOUT", 429);
            await delay(100, undefined, { signal: abortSignal });
          }
          abortSignal?.throwIfAborted();
          childState = await this.ensureChild(sessionId);
          const index = this.pendingStarts.indexOf(sessionId);
          if (index >= 0) this.pendingStarts.splice(index, 1);
          childState.streams.set(streamId, { streamId, queue });
          input = { ...input, acceptedRunId: runId, resumeExecution: true };
          childState.child.send?.({ type: "stream:start", streamId, mode: "resume", input });
          continue;
        }
        if (item.kind === "error") {
          throw new AgentRuntimeError(item.error, item.code ?? "STREAM_ERROR", item.code === "EXECUTION_SUPERSEDED" ? 409 : 500);
        }
        // The worker flushes its checkpoint before stream:done. Refresh the
        // host cache before idle release so exit cleanup preserves a waiting
        // run instead of interrupting the stale running projection.
        await agentRuntimeStore.hydrateSession(sessionId, true);
        break;
      }
    } finally {
      const queuedIndex = this.pendingStarts.indexOf(sessionId);
      if (queuedIndex >= 0) this.pendingStarts.splice(queuedIndex, 1);
      this.streamControllers.delete(sessionId);
      if (onAbort) {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      const state = this.children.get(sessionId);
      state?.streams.delete(streamId);
      this.activeMainStreams.delete(sessionId);
      // ponytail: services retain one worker/session; use a host supervisor if the existing process cap becomes limiting.
      // One-shot agent runs must free the process slot; otherwise idle
      // children accumulate up to MAX_AGENT_SESSION_PROCESSES and block dispatch.
      if (
        state &&
        state.streams.size === 0 &&
        state.compactions.size === 0 &&
        !(await hasBackgroundProcesses(sessionId, true))
      ) {
        this.releaseChild(sessionId, "Agent session stream finished.", { idle: true });
      }
    }
  }

  beginContextCompaction(sessionId: string): {
    accepted: true;
    status: "compacting";
  } {
    if (this.activeMainStreams.has(sessionId)) {
      throw new AgentRuntimeError(
        "Wait for the current run to finish before compacting context.",
        "SESSION_BUSY",
        409,
      );
    }
    assertSessionCanCompact(sessionId);
    if (this.pendingCompactions.has(sessionId)) {
      throw new AgentRuntimeError(
        "Context compaction is already running.",
        "COMPACTION_BUSY",
        409,
      );
    }
    this.assertCanSpawnChild(sessionId);
    const compaction: ContextCompactionState = {
      id: makeRuntimeId("cmp"),
      status: "running",
      startedAt: nowIso(),
      requestId: agentRuntimeStore.getSessionStats(sessionId).context.requestId,
    };
    saveContextCompaction(sessionId, compaction);
    this.pendingCompactions.add(sessionId);
    logger.info({ sessionId }, "[context-compaction] started");
    // An in-process session has no worker to receive `context:compact`.
    void (agentSessionsRunInProcess()
      ? this.runInProcessContextCompaction(sessionId, compaction)
      : this.runContextCompaction(sessionId, compaction));
    return { accepted: true, status: "compacting" };
  }

  /** Compact in the host process; only forked sessions have a worker to ask. */
  private async runInProcessContextCompaction(
    sessionId: string,
    compaction: ContextCompactionState,
  ): Promise<void> {
    try {
      const result = await compactSessionContextWithLlm(sessionId);
      logger.info(
        {
          sessionId,
          originalTokens: result.originalTokens,
          compressedTokens: result.tokens,
        },
        "[context-compaction] completed",
      );
      saveContextCompaction(sessionId, {
        ...compaction,
        status: "completed",
        completedAt: nowIso(),
        compacted: result.compacted,
        originalTokens: result.originalTokens,
        compressedTokens: result.tokens,
        messageCount: result.messageCount,
      });
    } catch (error) {
      logger.error({ err: error, sessionId }, "[context-compaction] failed");
      if (agentRuntimeStore.tryGetSession(sessionId)) {
        saveContextCompaction(sessionId, {
          ...compaction,
          status: "failed",
          completedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.pendingCompactions.delete(sessionId);
    }
  }

  private async runContextCompaction(
    sessionId: string,
    compaction: ContextCompactionState,
  ): Promise<void> {
    let request: ContextCompactionRequest | undefined;
    try {
      const state = await this.ensureChild(sessionId);
      const requestId = randomUUID();
      const result = await new Promise<ContextCompactionResult>(
        (resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new AgentRuntimeError(
                  "Context compaction timed out.",
                  "COMPACTION_TIMEOUT",
                  504,
                ),
              ),
            CONTEXT_COMPACTION_TIMEOUT_MS,
          );
          request = { requestId, resolve, reject, timer };
          state.compactions.set(requestId, request);
          state.child.send?.(
            { type: "context:compact", requestId },
            (error) => {
              if (error) reject(error);
            },
          );
        },
      );
      logger.info(
        {
          sessionId,
          originalTokens: result.originalTokens,
          compressedTokens: result.tokens,
        },
        "[context-compaction] completed",
      );
      saveContextCompaction(sessionId, {
        ...compaction,
        status: "completed",
        completedAt: nowIso(),
        compacted: result.compacted,
        originalTokens: result.originalTokens,
        compressedTokens: result.tokens,
        messageCount: result.messageCount,
      });
    } catch (error) {
      logger.error({ err: error, sessionId }, "[context-compaction] failed");
      if (agentRuntimeStore.tryGetSession(sessionId)) {
        saveContextCompaction(sessionId, {
          ...compaction,
          status: "failed",
          completedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (request) {
        clearTimeout(request.timer);
        const state = this.children.get(sessionId);
        state?.compactions.delete(request.requestId);
      }
      this.pendingCompactions.delete(sessionId);
      const state = this.children.get(sessionId);
      if (
        state &&
        state.streams.size === 0 &&
        state.compactions.size === 0 &&
        !(await hasBackgroundProcesses(sessionId, true))
      ) {
        this.releaseChild(sessionId, "Context compaction finished.", { idle: true });
      }
    }
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
  ): void {
    for (const sessionId of sessionIds) {
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

    this.releasingChildren.add(sessionId);
    if (options?.idle) this.idleChildren.add(state.child);
    if (state.child.exitCode == null && state.child.signalCode == null) {
      this.terminatingChildren.set(state.child, sessionId);
      const force = setTimeout(() => {
        if (this.terminatingChildren.has(state.child))
          state.child.kill("SIGKILL");
      }, 3000);
      force.unref();
      state.child.once("exit", () => {
        clearTimeout(force);
        this.terminatingChildren.delete(state.child);
      });
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

    // Free the slot immediately so another agent run can be dispatched.
    this.children.delete(sessionId);
    this.activeMainStreams.delete(sessionId);

    if (!state.child.killed) {
      state.child.kill("SIGTERM");
    }
  }

  async waitForIdleSessions(
    sessionIds: Iterable<string>,
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const deadline = Date.now() + timeoutMs;
    while (
      ids.some(
        (sessionId) =>
          this.activeMainStreams.has(sessionId) ||
          this.children.has(sessionId) ||
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
    return this.children.size + this.terminatingChildren.size;
  }

  private async ensureChild(sessionId: string): Promise<SessionChildState> {
    await prepareWorkerMetadata();
    const existing = this.children.get(sessionId);
    if (existing && existing.child.connected) {
      return existing;
    }
    if (existing) {
      this.children.delete(sessionId);
    }

    this.assertCanSpawnChild(sessionId);

    const session = agentRuntimeStore.getSession(sessionId);
    const init: AgentSessionChildInit = {
      sessionId,
      projectId: session.projectId,
      workDir: resolveSessionWorkDir(sessionId, session.projectId),
    };

    const runnerPath = resolveAgentSessionRunnerPath();
    const isTs = runnerPath.endsWith(".ts");
    const processTicket = prepareOwnedProcess("native-agent-worker", true);
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
      if (
        isAgentSessionChildMessage(message) &&
        message.type === "session:booted"
      ) {
        child.send?.({ type: "session:initialize" });
        return;
      }
      void this.handleChildMessage(sessionId, message).catch(error => logger.error({sessionId,error}, "Worker message handling failed"));
    });

    child.on("exit", (code, signal) => {
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
        try {
          if (agentRuntimeStore.tryGetSession(sessionId)) {
            const reason = `Agent session worker exited (code ${code}, signal ${signal}).`;
            const ids = agentRuntimeStore
              .listSessionTree(sessionId)
              // Waiting runs are durable continuations, not abandoned work.
              // Reclaim their idle worker without invalidating pending input.
              .filter(
                (session) =>
                  !this.idleChildren.has(child) ||
                  (session.status !== "waiting_input" &&
                    session.status !== "waiting_permission"),
              )
              .map((session) => session.id);
            finalizeStoppedSessions(ids, reason);
          }
        } catch (error) {
          logger.error(
            { sessionId, err: error },
            "[agent-session] failed to reconcile exited worker",
          );
        }
      }
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
    });

    const ready = this.waitForChildReady(sessionId);
    await waitForAuthoritativeLease(processTicket.id);
    child.send?.({ type: "session:initialize" });
    await ready;
    logger.info({ sessionId, pid: child.pid }, "[agent-session] child started");
    return state;
  }

  private waitForChildReady(sessionId: string): Promise<void> {
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

      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };

      child.on("message", onMessage);
      child.once("exit", onExit);
    });
  }

  private async handleChildMessage(sessionId: string, message: unknown): Promise<void> {
    if (!isAgentSessionChildMessage(message)) return;

    if (message.type === "session:live") {
      sessionLiveBus.emit(message.sessionId, message.event);
      return;
    }

    if (message.type === "runtime:event") {
      runtimeBus.emit(message.event);
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

    if (message.type === "stream:chunk") {
      maybeScheduleSessionTitleFromStreamChunk(sessionId, message.chunk);
      forwardChunkToLiveBus(sessionId, message.chunk);
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: "chunk", chunk: message.chunk });
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
