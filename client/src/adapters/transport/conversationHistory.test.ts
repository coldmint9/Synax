import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./origin', () => ({ apiRequest: mocks.request }));
import { conversationHistoryApi } from './conversationHistory';

beforeEach(() => vi.resetAllMocks());

it.each([['m1'], Array.from({ length: 64 }, (_, index) => `m${index}`), Array.from({ length: 65 }, (_, index) => `m${index}`)].map(ids => ({ ids })))('filters a small checkpoint query: $ids', async ({ ids }) => {
  const signal = new AbortController().signal;
  await conversationHistoryApi.list('s/1', signal, ids);
  expect(mocks.request).toHaveBeenCalledOnce();
  const [url, options] = mocks.request.mock.calls[0];
  expect(new URL(url, 'http://localhost').searchParams.get('messageIds')).toBe(JSON.stringify(ids));
  expect(url).toContain('/sessions/s%2F1/checkpoints');
  expect(options).toEqual({ signal, silent: true });
});

it('uses a bounded body filter for long IDs instead of dropping the filter', async () => {
  const ids = Array.from({ length: 64 }, (_, index) => `${index}${'x'.repeat(250)}`);
  const summary = { sessionId: 's', revision: 42, checkpoints: [], readOnlyMessageIds: [ids[0]] };
  mocks.request.mockResolvedValue(summary);
  const signal = new AbortController().signal;
  expect(await conversationHistoryApi.list('s', signal, ids)).toBe(summary);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/checkpoints', {
    signal, silent: true, method: 'POST', body: JSON.stringify({ messageIds: ids }),
  });
});

it('keeps an unfiltered query when no message IDs were supplied', async () => {
  await conversationHistoryApi.list('s');
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/checkpoints', { signal: undefined, silent: true });
});

it('keeps an unfiltered query while the transcript is still empty', async () => {
  await conversationHistoryApi.list('s', undefined, []);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/checkpoints', { signal: undefined, silent: true });
});

it('uses truncate_history with explicit session mode for rollback', async () => {
  await conversationHistoryApi.preview('s', 'cp', 'rollback', 'session');
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/history/preview', expect.objectContaining({
    body: JSON.stringify({ checkpointId: 'cp', action: 'truncate_history', mode: 'session' }),
  }));
  await conversationHistoryApi.apply('s', 'rollback', { checkpointId: 'cp', revision: 1, requestId: 'r', mode: 'session' });
  expect(mocks.request).toHaveBeenLastCalledWith('/api/agent-runtime/sessions/s/history/truncate_history', expect.anything());
});
