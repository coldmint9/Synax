import { expect, it, vi } from 'vitest';

vi.mock('../process-ownership.js', () => ({ hasBackgroundProcesses: vi.fn(async () => false) }));
vi.mock('../session-title-service.js', () => ({ ensureSessionTitleGenerated: vi.fn(), maybeScheduleSessionTitleFromStreamChunk: vi.fn() }));
import { sessionProcessManager, SessionProcessManager } from '../session-process-manager.js';
import { agentRuntimeStore } from '../session-store.js';
import { MAX_AGENT_SESSION_PROCESSES } from '../../../infrastructure/runtime/env.js';

it('preserves a worker lease rejection through IPC instead of converting it into a generic run failure', async () => {
  const manager = sessionProcessManager;
  const internal = manager as any;
  const state = { sessionId: 's', streams: new Map(), compactions: new Map(), child: {
    connected: true,
    send(message: { type: string; streamId: string }) {
      if (message.type === 'stream:start') queueMicrotask(() => internal.handleChildMessage('s', {
        type: 'stream:error', sessionId: 's', streamId: message.streamId,
        error: 'Execution owner changed', code: 'EXECUTION_SUPERSEDED',
      }));
    },
  } };
  internal.children.set('s', state);
  vi.spyOn(internal, 'ensureChild').mockResolvedValue(state);
  vi.spyOn(internal, 'releaseChild').mockImplementation(() => internal.children.delete('s'));
  await expect(manager.streamSession('s', 'turn', {}).next()).rejects.toMatchObject({
    message: 'Execution owner changed', code: 'EXECUTION_SUPERSEDED', status: 409,
  });
  expect(manager.isSessionStreaming('s')).toBe(false);
});

it('reports the ninth worker as queued and dispatches waiting sessions in order when a slot is released', async () => {
  const manager = new SessionProcessManager(); const internal = manager as any;
  const spawned: string[] = [];
  const progress = vi.spyOn(agentRuntimeStore, 'updateRun').mockImplementation((id, patch) => ({ id, sessionId: id, ...patch }) as never);
  const hydrate = vi.spyOn(agentRuntimeStore, 'hydrateSession').mockResolvedValue(undefined);
  for (let i = 0; i < MAX_AGENT_SESSION_PROCESSES; i++) internal.children.set(`busy-${i}`, { child: { connected: true, send() {} } });
  vi.spyOn(internal, 'ensureChild').mockImplementation(async (value: unknown) => {
    const id = String(value);
    spawned.push(id);
    const child = { connected: true, send(message: { type: string; streamId: string }) {
      if (message.type === 'stream:start') queueMicrotask(() => internal.handleChildMessage(id, { type: 'stream:done', sessionId: id, streamId: message.streamId }));
    } };
    const state = { sessionId: id, child, streams: new Map(), compactions: new Map() }; internal.children.set(id, state); return state;
  });
  vi.spyOn(internal, 'releaseChild').mockImplementation((id: unknown) => internal.children.delete(String(id)));
  const ninth = manager.streamSession('ninth', 'turn', { acceptedRunId: 'ninth' });
  const tenth = manager.streamSession('tenth', 'turn', { acceptedRunId: 'tenth' });
  expect((await ninth.next()).value).toMatchObject({ type: 'execution_status', execution: { phase: 'queued_resources', resource: 'worker' } });
  expect((await tenth.next()).value).toMatchObject({ type: 'execution_status', execution: { phase: 'queued_resources' } });
  internal.children.delete('busy-0');
  await Promise.all([ninth.next(), tenth.next()]);
  expect(spawned).toEqual(['ninth', 'tenth']);
  progress.mockRestore(); hydrate.mockRestore();
});
