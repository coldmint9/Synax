import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAgentSessionChildMessage,
  forwardChunkToLiveBus,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from '../../lib/ipc/agent-session-protocol.js';
import { MAX_AGENT_SESSION_PROCESSES, AGENT_SESSION_CHILD_READY_TIMEOUT_MS } from '../../lib/env.js';
import { resolveSessionWorkDir } from './tools/workspace.js';
import { logger } from '../../lib/logger.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from './contracts.js';
import { AgentRuntimeError } from './runtime-errors.js';
import { agentRuntimeStore } from './session-store.js';
import { sessionLiveBus } from './session-live-bus.js';
import { runtimeBus } from './runtime-bus.js';
import {
  ensureSessionTitleGenerated,
  maybeScheduleSessionTitleFromStreamChunk,
} from './session-title-service.js';

const ACTIVE_SESSION_WAIT_MS = 25;
const ACTIVE_SESSION_TIMEOUT_MS = 5_000;
const CHILD_READY_TIMEOUT_MS = AGENT_SESSION_CHILD_READY_TIMEOUT_MS;

type StreamQueueItem =
  | { kind: 'chunk'; chunk: AgentRunStreamChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: string };

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
    if (this.closed) return { kind: 'done' };
    return new Promise<StreamQueueItem>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve({ kind: 'done' });
    }
    this.resolvers = [];
  }
}

interface ActiveStream {
  streamId: string;
  queue: StreamQueue;
}

interface SessionChildState {
  sessionId: string;
  child: ChildProcess;
  streams: Map<string, ActiveStream>;
}

function resolveAgentSessionRunnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsRunner = path.resolve(here, '../../workers/agent-session-runner.ts');
  if (fs.existsSync(tsRunner)) return tsRunner;
  return path.resolve(here, '../../../server-dist/workers/agent-session-runner.cjs');
}

class SessionProcessManager {
  private readonly children = new Map<string, SessionChildState>();
  private readonly activeMainStreams = new Set<string>();

  isSessionStreaming(sessionId: string): boolean {
    return this.activeMainStreams.has(sessionId);
  }

  canSpawnChild(sessionId?: string): boolean {
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
      'SESSION_LIMIT',
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
        'Session already has an active run.',
        'SESSION_BUSY',
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
          type: 'stream:cancel',
          streamId,
          reason: 'Client disconnected.',
        });
        queue.close();
      };

      if (abortSignal?.aborted) {
        onAbort();
      } else {
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      }

      childState.child.send?.({
        type: 'stream:start',
        streamId,
        mode,
        input,
      });

      while (true) {
        const item = await queue.next();
        if (item.kind === 'chunk') {
          yield item.chunk;
          continue;
        }
        if (item.kind === 'error') {
          throw new AgentRuntimeError(item.error, 'STREAM_ERROR', 500);
        }
        break;
      }
    } finally {
      if (onAbort) {
        abortSignal?.removeEventListener('abort', onAbort);
      }
      const state = this.children.get(sessionId);
      state?.streams.delete(streamId);
      this.activeMainStreams.delete(sessionId);
    }
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = 'Agent runtime session deleted by user.',
  ): void {
    for (const sessionId of sessionIds) {
      const state = this.children.get(sessionId);
      if (!state) continue;
      state.child.send?.({ type: 'session:interrupt', reason });
      for (const stream of state.streams.values()) {
        stream.queue.push({ kind: 'error', error: reason });
        stream.queue.close();
      }
      state.streams.clear();
      if (!state.child.killed) {
        state.child.kill('SIGTERM');
      }
      this.children.delete(sessionId);
      this.activeMainStreams.delete(sessionId);
    }
  }

  async waitForIdleSessions(
    sessionIds: Iterable<string>,
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const deadline = Date.now() + timeoutMs;
    while (ids.some((sessionId) => this.activeMainStreams.has(sessionId) || this.children.has(sessionId))) {
      if (Date.now() >= deadline) {
        throw new AgentRuntimeError(
          'Timed out while waiting for active agent runtime sessions to stop.',
          'DELETE_TIMEOUT',
          409,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_SESSION_WAIT_MS));
    }
  }

  async interruptAndWaitForSessions(
    sessionIds: Iterable<string>,
    reason = 'Agent runtime session deleted by user.',
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    this.interruptSessions(sessionIds, reason);
    await this.waitForIdleSessions(sessionIds, timeoutMs);
  }

  private countChildren(): number {
    return this.children.size;
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
    const isTs = runnerPath.endsWith('.ts');
    const child = fork(runnerPath, [], {
      env: {
        ...process.env,
        SYNAX_AGENT_SESSION_CHILD: '1',
        AGENT_SESSION_INIT: JSON.stringify(init),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: isTs ? ['--import', 'tsx/esm'] : [],
    });

    const state: SessionChildState = {
      sessionId,
      child,
      streams: new Map(),
    };
    this.children.set(sessionId, state);

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ sessionId, chunk: chunk.toString().trimEnd() }, '[agent-session] child stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn({ sessionId, chunk: chunk.toString().trimEnd() }, '[agent-session] child stderr');
    });

    child.on('message', (message: unknown) => {
      this.handleChildMessage(sessionId, message);
    });

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        logger.error({ sessionId, code, signal }, '[agent-session] child exited abnormally');
      }
      const current = this.children.get(sessionId);
      if (current?.child === child) {
        for (const stream of current.streams.values()) {
          stream.queue.push({ kind: 'error', error: 'Agent session child process exited.' });
          stream.queue.close();
        }
        this.children.delete(sessionId);
      }
      this.activeMainStreams.delete(sessionId);
    });

    await this.waitForChildReady(sessionId);
    logger.info({ sessionId, pid: child.pid }, '[agent-session] child started');
    return state;
  }

  private waitForChildReady(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new AgentRuntimeError('Agent session child failed to become ready.', 'CHILD_READY_TIMEOUT', 500));
      }, CHILD_READY_TIMEOUT_MS);

      const onMessage = (message: unknown) => {
        if (!isAgentSessionChildMessage(message)) return;
        if (message.type === 'session:ready' && message.sessionId === sessionId) {
          cleanup();
          resolve();
        }
      };

      const state = this.children.get(sessionId);
      const child = state?.child;
      if (!child) {
        clearTimeout(timeout);
        reject(new AgentRuntimeError('Agent session child missing during ready wait.', 'CHILD_MISSING', 500));
        return;
      }

      const onExit = () => {
        cleanup();
        reject(new AgentRuntimeError('Agent session child exited before ready.', 'CHILD_EXITED', 500));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };

      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  }

  private handleChildMessage(sessionId: string, message: unknown): void {
    if (!isAgentSessionChildMessage(message)) return;

    if (message.type === 'session:live') {
      sessionLiveBus.emit(message.sessionId, message.event);
      return;
    }

    if (message.type === 'runtime:event') {
      runtimeBus.emit(message.event);
      return;
    }

    if (message.sessionId !== sessionId) return;

    const state = this.children.get(sessionId);
    if (!state) return;

    if (message.type === 'stream:chunk') {
      maybeScheduleSessionTitleFromStreamChunk(sessionId, message.chunk);
      forwardChunkToLiveBus(sessionId, message.chunk);
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: 'chunk', chunk: message.chunk });
      return;
    }

    if (message.type === 'stream:done') {
      ensureSessionTitleGenerated(sessionId);
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: 'done' });
      stream?.queue.close();
      return;
    }

    if (message.type === 'stream:error') {
      const stream = state.streams.get(message.streamId);
      stream?.queue.push({ kind: 'error', error: message.error });
      stream?.queue.close();
    }
  }
}

export const sessionProcessManager = new SessionProcessManager();
