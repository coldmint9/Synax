import {
  prepareOwnedProcess,
  recordOwnedPid,
  releaseOwnedProcess,
  hasBackgroundProcesses,
} from "./process-ownership.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeAsset } from "../../lib/runtime-paths.js";
import {
  isAgentSessionChildMessage,
  forwardChunkToLiveBus,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from "../../lib/ipc/agent-session-protocol.js";
import {
  MAX_AGENT_SESSION_PROCESSES,
  AGENT_SESSION_CHILD_READY_TIMEOUT_MS,
} from "../../lib/env.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import { logger } from "../../lib/logger.js";
import type { AgentRunStreamChunk, StreamTurnRequest } from "./contracts.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  assertSessionCanCompact,
  type ContextCompactionResult,
} from "./manual-context-compaction.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { runtimeBus } from "./runtime-bus.js";
import {
  ensureSessionTitleGenerated,
  maybeScheduleSessionTitleFromStreamChunk,
} from "./session-title-service.js";

const ACTIVE_SESSION_WAIT_MS = 25;
const ACTIVE_SESSION_TIMEOUT_MS = 5_000;
const CHILD_READY_TIMEOUT_MS = AGENT_SESSION_CHILD_READY_TIMEOUT_MS;
const CONTEXT_COMPACTION_TIMEOUT_MS = 5 * 60_000;

type StreamQueueItem =
  | { kind: "chunk"; chunk: AgentRunStreamChunk }
  | { kind: "done" }
  | { kind: "error"; error: string };

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
  sessionId: string;
  child: ChildProcess;
  streams: Map<string, ActiveStream>;
  compactions: Map<string, ContextCompactionRequest>;
}

function resolveAgentSessionRunnerPath(): string {
  const runner = runtimeAsset(
    import.meta.url,
    "../../workers/agent-session-runner.ts",
    "workers/agent-session-runner.cjs",
  );
  if (!fs.existsSync(runner))
    throw new Error(
      "The agent-session-runner executable is missing from this Runtime build.",
    );
  return runner;
}

class SessionProcessManager {
  private readonly children = new Map<string, SessionChildState>();
  private readonly activeMainStreams = new Set<string>();
  /** Sessions whose children we are intentionally tearing down (idle release / interrupt). */
  private readonly releasingChildren = new Set<string>();
  private readonly terminatingChildren = new Map<ChildProcess, string>();
  private readonly pendingCompactions = new Set<string>();

  isSessionStreaming(sessionId: string): boolean {
    return this.activeMainStreams.has(sessionId);
  }

  canSpawnChild(sessionId?: string): boolean {
    if (sessionId && [...this.terminatingChildren.values()].includes(sessionId))
      return false;
    if (sessionId) {
      const existing = this.children.get(sessionId);
      if (existing?.child.connected) return true;
    }
    return this.countChildren() < MAX_AGENT_SESSION_PROCESSES;
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

    this.assertCanSpawnChild(sessionId);

    this.activeMainStreams.add(sessionId);
    const streamId = randomUUID();
    const queue = new StreamQueue();
    let childState: SessionChildState;
    let onAbort: (() => void) | undefined;

    try {
      childState = await this.ensureChild(sessionId);
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
        if (item.kind === "error") {
          throw new AgentRuntimeError(item.error, "STREAM_ERROR", 500);
        }
        break;
      }
    } finally {
      if (onAbort) {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      const state = this.children.get(sessionId);
      state?.streams.delete(streamId);
      this.activeMainStreams.delete(sessionId);
      // ponytail: services retain one worker/session; use a host supervisor if the existing process cap becomes limiting.
      // One-shot wiki/agent runs must free the process slot; otherwise idle
      // children accumulate up to MAX_AGENT_SESSION_PROCESSES and block dispatch.
      if (
        state &&
        state.streams.size === 0 &&
        state.compactions.size === 0 &&
        !hasBackgroundProcesses(sessionId, true)
      ) {
        this.releaseChild(sessionId, "Agent session stream finished.");
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
    this.pendingCompactions.add(sessionId);
    logger.info({ sessionId }, "[context-compaction] started");
    sessionLiveBus.emit(sessionId, { type: "context_compaction_started" });
    void this.runContextCompaction(sessionId);
    return { accepted: true, status: "compacting" };
  }

  private async runContextCompaction(sessionId: string): Promise<void> {
    let request: ContextCompactionRequest | undefined;
    try {
      const state = await this.ensureChild(sessionId);
      const requestId = randomUUID();
      const result = await new Promise<ContextCompactionResult>((resolve, reject) => {
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
      });
      logger.info(
        { sessionId, originalTokens: result.originalTokens, compressedTokens: result.tokens },
        "[context-compaction] completed",
      );
      sessionLiveBus.emit(sessionId, {
        type: "context_compacted",
        stepId: "",
        originalTokens: result.originalTokens,
        compressedTokens: result.tokens,
        messageCount: result.messageCount,
      });
    } catch (error) {
      logger.error({ err: error, sessionId }, "[context-compaction] failed");
      sessionLiveBus.emit(sessionId, {
        type: "context_compaction_failed",
        error: error instanceof Error ? error.message : String(error),
      });
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
        !hasBackgroundProcesses(sessionId, true)
      ) {
        this.releaseChild(sessionId, "Context compaction finished.");
      }
    }
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
  ): void {
    for (const sessionId of sessionIds) {
      this.releaseChild(sessionId, reason, { pushStreamError: true });
    }
  }

  private releaseChild(
    sessionId: string,
    reason: string,
    options?: { pushStreamError?: boolean },
  ): void {
    const state = this.children.get(sessionId);
    if (!state) return;

    this.releasingChildren.add(sessionId);
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

    // Free the slot immediately so wiki write-queue can dispatch the next doc.
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
      sessionId,
      child,
      streams: new Map(),
      compactions: new Map(),
    };
    this.children.set(sessionId, state);

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
      this.handleChildMessage(sessionId, message);
    });

    child.on("exit", (code, signal) => {
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
      this.activeMainStreams.delete(sessionId);
    });

    const ready = this.waitForChildReady(sessionId);
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

  private handleChildMessage(sessionId: string, message: unknown): void {
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
        !hasBackgroundProcesses(sessionId, true)
      ) {
        this.releaseChild(sessionId, "All background services have exited.");
      }
      return;
    }

    if (message.sessionId !== sessionId) return;

    const state = this.children.get(sessionId);
    if (!state) return;

    if (message.type === "context:compact:done" || message.type === "context:compact:error") {
      const request = state.compactions.get(message.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      state.compactions.delete(message.requestId);
      if (message.type === "context:compact:done") request.resolve(message.result);
      else request.reject(new AgentRuntimeError(message.error, "COMPACTION_FAILED", 500));
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

    if (message.type === "stream:error") {
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: "error", error: message.error });
      stream?.queue.close();
    }
  }
}

export const sessionProcessManager = new SessionProcessManager();
