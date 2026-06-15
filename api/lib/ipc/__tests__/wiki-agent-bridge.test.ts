import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

const mockStreamSession = vi.fn();

vi.mock('../../../services/agent-runtime/session-process-manager.js', () => ({
  sessionProcessManager: {
    streamSession: (...args: unknown[]) => mockStreamSession(...args),
  },
}));

import {
  handleWikiAgentChildMessage,
  cancelWikiAgentRequestsForChild,
} from '../wiki-agent-bridge.js';

function makeWikiChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.connected = true;
  child.pid = 4242;
  child.send = vi.fn();
  return child;
}

describe('wiki-agent-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards agent chunks from sessionProcessManager to wiki child', async () => {
    async function* fakeStream() {
      yield { type: 'done', sessionId: 'sess-1', runId: 'run-1' };
    }
    mockStreamSession.mockReturnValue(fakeStream());

    const child = makeWikiChild();
    handleWikiAgentChildMessage(child, {
      type: 'agent:request',
      requestId: 'req-1',
      sessionId: 'sess-1',
      mode: 'turn',
      input: { locale: 'zh' },
    });

    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith({
        type: 'agent:chunk',
        requestId: 'req-1',
        chunk: { type: 'done', sessionId: 'sess-1', runId: 'run-1' },
      });
    });

    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith({ type: 'agent:done', requestId: 'req-1' });
    });
  });

  it('aborts in-flight stream when agent:cancel is received', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStreamSession.mockImplementation((_sessionId, _mode, _input, signal: AbortSignal) => {
      capturedSignal = signal;
      return (async function* () {
        yield { type: 'done', sessionId: 'sess-2', runId: 'run-2' };
      })();
    });

    const child = makeWikiChild();
    handleWikiAgentChildMessage(child, {
      type: 'agent:request',
      requestId: 'req-2',
      sessionId: 'sess-2',
      mode: 'turn',
      input: {},
    });

    handleWikiAgentChildMessage(child, {
      type: 'agent:cancel',
      requestId: 'req-2',
      reason: 'test cancel',
    });

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('cancels active requests when wiki child exits', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockStreamSession.mockImplementation((_sessionId, _mode, _input, signal: AbortSignal) => {
      capturedSignal = signal;
      return (async function* () {
        await new Promise(() => {});
      })();
    });

    const child = makeWikiChild();
    handleWikiAgentChildMessage(child, {
      type: 'agent:request',
      requestId: 'req-3',
      sessionId: 'sess-3',
      mode: 'turn',
      input: {},
    });

    cancelWikiAgentRequestsForChild(child.pid);
    expect(capturedSignal?.aborted).toBe(true);
  });
});
