import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock, getSessionMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    fork: forkMock,
  };
});

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: {
    getSession: getSessionMock,
    tryGetSession: vi.fn(),
  },
}));

vi.mock('../session-title-service.js', () => ({
  ensureSessionTitleGenerated: vi.fn(),
  maybeScheduleSessionTitleFromStreamChunk: vi.fn(),
}));

vi.mock('../session-live-bus.js', () => ({
  sessionLiveBus: { emit: vi.fn(), subscribe: vi.fn(), cleanup: vi.fn() },
}));

vi.mock('../runtime-bus.js', () => ({
  runtimeBus: { emit: vi.fn() },
}));

vi.mock('../tools/workspace.js', () => ({
  resolveSessionWorkDir: () => '/tmp/synax-test-workdir',
}));

vi.mock('../../../lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/env.js')>();
  return {
    ...actual,
    MAX_AGENT_SESSION_PROCESSES: 2,
    AGENT_SESSION_CHILD_READY_TIMEOUT_MS: 5_000,
  };
});

import { sessionProcessManager } from '../session-process-manager.js';

function createMockChild(sessionId: string) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    connected: boolean;
    killed: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
  };
  child.pid = Math.floor(Math.random() * 10_000) + 1;
  child.connected = true;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.send = vi.fn((message: { type: string; streamId?: string }) => {
    if (message.type === 'stream:start' && message.streamId) {
      queueMicrotask(() => {
        child.emit('message', {
          type: 'stream:done',
          sessionId,
          streamId: message.streamId,
        });
      });
    }
  });
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.connected = false;
    queueMicrotask(() => child.emit('exit', 0, signal ?? null));
    return true;
  });
  return child;
}

describe('sessionProcessManager idle child release', () => {
  beforeEach(() => {
    forkMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockImplementation((sessionId: string) => ({
      id: sessionId,
      projectId: 'proj-test',
      status: 'running',
    }));
  });

  afterEach(() => {
    sessionProcessManager.interruptSessions(
      ['sess-release-a', 'sess-release-b', 'sess-release-c'],
      'test cleanup',
    );
  });

  it('releases the child after stream finishes so capacity is freed', async () => {
    const childA = createMockChild('sess-release-a');
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childA.emit('message', { type: 'session:ready', sessionId: 'sess-release-a' });
      });
      return childA;
    });

    const chunks: unknown[] = [];
    for await (const chunk of sessionProcessManager.streamSession('sess-release-a', 'turn', {})) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    expect(childA.kill).toHaveBeenCalled();
    expect(sessionProcessManager.canSpawnChild()).toBe(true);
    await sessionProcessManager.waitForIdleSessions(['sess-release-a']);
  });

  it('does not leak slots across sequential one-shot sessions at capacity', async () => {
    const sessions = ['sess-release-a', 'sess-release-b', 'sess-release-c'] as const;

    for (const sessionId of sessions) {
      const child = createMockChild(sessionId);
      forkMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.emit('message', { type: 'session:ready', sessionId });
        });
        return child;
      });

      for await (const _chunk of sessionProcessManager.streamSession(sessionId, 'turn', {})) {
        // drain
      }
    }

    // MAX_AGENT_SESSION_PROCESSES is mocked to 2; without release the 3rd spawn would fail.
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(sessionProcessManager.canSpawnChild()).toBe(true);
  });
});
