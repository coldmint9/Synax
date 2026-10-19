import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./origin', () => ({ apiRequest: mocks.request }));
import { conversationHistoryApi } from './conversationHistory';

beforeEach(() => vi.resetAllMocks());

it.each([[], ['m1'], Array.from({ length: 64 }, (_, index) => `m${index}`)].map(ids => ({ ids })))('filters a small checkpoint query: $ids', async ({ ids }) => {
  const signal = new AbortController().signal;
  await conversationHistoryApi.list('s/1', signal, ids);
  expect(mocks.request).toHaveBeenCalledOnce();
  const [url, options] = mocks.request.mock.calls[0];
  expect(new URL(url, 'http://localhost').searchParams.get('messageIds')).toBe(JSON.stringify(ids));
  expect(url).toContain('/sessions/s%2F1/checkpoints');
  expect(options).toEqual({ signal, silent: true });
});

it.each([
  Array.from({ length: 65 }, (_, index) => `m${index}`),
  Array.from({ length: 64 }, (_, index) => `${index}${'x'.repeat(250)}`),
].map(ids => ({ ids })))('uses one unfiltered query for long transcripts without dropping older checkpoints', async ({ ids }) => {
  const summary = { sessionId: 's', revision: 42, checkpoints: [{ messageId: ids[0] }, { messageId: ids.at(-1) }] };
  mocks.request.mockResolvedValue(summary);
  const signal = new AbortController().signal;
  expect(await conversationHistoryApi.list('s', signal, ids)).toBe(summary);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/checkpoints', { signal, silent: true });
});

it('keeps an unfiltered query when no message IDs were supplied', async () => {
  await conversationHistoryApi.list('s');
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('/api/agent-runtime/sessions/s/checkpoints', { signal: undefined, silent: true });
});
