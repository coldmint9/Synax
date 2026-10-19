import { describe, expect, it, vi } from 'vitest';
import { RuntimeSidecarError, type RuntimeSidecarClient } from './sidecar-client.js';
import { readHistoryList } from './history-pages.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('readHistoryList', () => {
  it('restarts the whole paged read when a live session advances its revision', async () => {
    let pass = 0;
    const client = {
      historyCommand: vi.fn(async (input: { payload?: { cursor?: unknown } }) => {
        if (input.payload?.cursor === undefined) {
          pass += 1;
          return encode(
            pass === 1
              ? { items: [{ id: 'from-old-head' }], cursor: { revision: 1, after: 'next' } }
              : { items: [{ id: 'from-new-head' }] },
          );
        }
        throw new RuntimeSidecarError({
          type: 'error',
          code: 'REVISION_CONFLICT',
          message: 'session revision is stale',
          expected: 1,
          actual: 2,
        });
      }),
    } as unknown as RuntimeSidecarClient;

    await expect(readHistoryList(client, 'session-1', 'list_messages')).resolves.toEqual([
      { id: 'from-new-head' },
    ]);
    expect(client.historyCommand).toHaveBeenCalledTimes(3);
  });
});

it('rehydrates a large entity in bounded chunks instead of dropping it', async () => {
  const value = { id: 'large', content: '中文🙂'.repeat(200_000) };
  const serialized = JSON.stringify(value), buffer = Buffer.from(serialized);
  const historyCommand = vi.fn(async (input: { operation: string; payload: { offset?: number } }) => {
    if (input.operation === 'list_messages') return encode({items:[{$historyObject:'sha256:large',bytes:buffer.length}]});
    const start = input.payload.offset ?? 0;
    let end = Math.min(start + 65_536, buffer.length);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    return encode({text:buffer.subarray(start,end).toString('utf8'),next:end < buffer.length ? end : null});
  });
  const client = {historyCommand} as unknown as RuntimeSidecarClient;
  expect(await readHistoryList(client,'s','list_messages')).toEqual([value]);
  expect(historyCommand.mock.calls.filter(([input]) => input.operation === 'list_messages')).toHaveLength(1);
  expect(historyCommand.mock.calls.length).toBeGreaterThan(10);
});
