import { expect, it, vi } from 'vitest';

vi.mock('../process-ownership.js', () => ({ hasBackgroundProcesses: vi.fn(async () => false) }));
vi.mock('../session-title-service.js', () => ({ ensureSessionTitleGenerated: vi.fn(), maybeScheduleSessionTitleFromStreamChunk: vi.fn() }));
import { sessionProcessManager } from '../session-process-manager.js';

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
