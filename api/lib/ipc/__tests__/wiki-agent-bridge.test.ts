import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ signals: new Map<string, AbortSignal>() }));
vi.mock('../../../services/agent-runtime/session-process-manager.js', () => ({ sessionProcessManager: {
  streamSession: async function* (id: string, _mode: string, _input: unknown, signal: AbortSignal) {
    state.signals.set(id, signal);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
} }));
import { cancelWikiAgentRequestsForChild, handleWikiAgentChildMessage } from '../wiki-agent-bridge.js';

describe('embedded Wiki host ownership', () => {
  it('never cancels another job when a child exits or forges a cancel request', async () => {
    const a = { pid: 101, connected: true, send: vi.fn() } as unknown as ChildProcess;
    const b = { pid: 202, connected: true, send: vi.fn() } as unknown as ChildProcess;
    handleWikiAgentChildMessage(a, { type: 'agent:request', requestId: 'request-a', sessionId: 'a', mode: 'turn', input: {} });
    handleWikiAgentChildMessage(b, { type: 'agent:request', requestId: 'request-b', sessionId: 'b', mode: 'turn', input: {} });
    await vi.waitFor(() => expect(state.signals.size).toBe(2));
    handleWikiAgentChildMessage(a, { type: 'agent:cancel', requestId: 'request-b' });
    expect(state.signals.get('b')!.aborted).toBe(false);
    cancelWikiAgentRequestsForChild(101);
    expect(state.signals.get('a')!.aborted).toBe(true);
    expect(state.signals.get('b')!.aborted).toBe(false);
    cancelWikiAgentRequestsForChild(undefined);
    expect(state.signals.get('b')!.aborted).toBe(false);
    cancelWikiAgentRequestsForChild(202);
    await vi.waitFor(() => expect(b.send).toHaveBeenCalled());
  });
});
