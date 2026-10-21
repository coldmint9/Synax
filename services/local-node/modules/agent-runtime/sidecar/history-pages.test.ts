import { describe, expect, it, vi } from 'vitest';
import { RuntimeSidecarError, type RuntimeSidecarClient } from './sidecar-client.js';
import { hydrateHistoryValues, readHistoryList, readSessionList, sessionPages } from './history-pages.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it('waits asynchronously for the session index without treating partial discovery as an empty list', async () => {
  const sessionList = vi.fn()
    .mockResolvedValueOnce(encode({ items: [], loading: true }))
    .mockResolvedValueOnce(encode({ items: [{ id: 'first' }], next: 'next' }))
    .mockResolvedValueOnce(encode({ items: [{ id: 'second' }] }));
  await expect(readSessionList({ sessionList } as unknown as RuntimeSidecarClient)).resolves.toEqual([{ id: 'first' }, { id: 'second' }]);
  expect(sessionList.mock.calls).toEqual([[undefined], [undefined], ['next']]);
});

it('stops index polling when the host is shutting down', async () => {
  const controller = new AbortController();
  const sessionList = vi.fn(async () => { controller.abort(); return encode({ items: [], loading: true }); });
  const read = async () => { for await (const _items of sessionPages({ sessionList } as unknown as RuntimeSidecarClient, controller.signal)) { /* no partial publication */ } };
  await expect(read()).rejects.toThrow();
  expect(sessionList).toHaveBeenCalledTimes(1);
});

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

it.each([false, true])('reads legacy history-window references without a byte count (global=%s)', async (global) => {
  const value = { id: 'system-context', content: '上下文🙂'.repeat(12_000) };
  const serialized = Buffer.from(JSON.stringify(value));
  const command = vi.fn(async (input: { operation: string; payload: { offset: number } }) => {
    expect(input.operation).toBe('object_value_chunk');
    const offset = input.payload.offset;
    let end = Math.min(offset + 65_536, serialized.length);
    while (end < serialized.length && (serialized[end] & 0xc0) === 0x80) end--;
    return encode({ text: serialized.subarray(offset, end).toString('utf8'), next: end < serialized.length ? end : null });
  });
  const client = { historyCommand: command, historyCommandGlobal: command } as unknown as RuntimeSidecarClient;
  await expect(hydrateHistoryValues(client, 's', [{ $historyObject: 'sha256:context', id: value.id }], global))
    .resolves.toEqual([value]);
  expect(command).toHaveBeenCalledTimes(Math.ceil(serialized.length / 65_536));
});

it.each([-1, 4 * 1024 * 1024 + 1, 1.5, null, '40000'])('rejects invalid declared history object size %s', async bytes => {
  const command = vi.fn();
  const client = { historyCommand: command } as unknown as RuntimeSidecarClient;
  await expect(hydrateHistoryValues(client, 's', [{ $historyObject: 'sha256:bad', bytes }]))
    .rejects.toThrow('Invalid history object size.');
  expect(command).not.toHaveBeenCalled();
});

it.each([
  { text: 'x', next: 0 },
  { text: '', next: 1 },
  { text: '中文', next: 2 },
  { next: null },
])('rejects invalid history chunk progress %j', async page => {
  const client = { historyCommand: vi.fn(async () => encode(page)) } as unknown as RuntimeSidecarClient;
  await expect(hydrateHistoryValues(client, 's', [{ $historyObject: 'sha256:bad' }]))
    .rejects.toThrow('History object chunk did not advance.');
});

it('enforces the object byte bound even when an older sidecar omits its size', async () => {
  const command = vi.fn(async (input: { payload: { offset: number } }) => encode({
    text: 'x'.repeat(65_536), next: input.payload.offset + 65_536,
  }));
  const client = { historyCommand: command } as unknown as RuntimeSidecarClient;
  await expect(hydrateHistoryValues(client, 's', [{ $historyObject: 'sha256:bad' }]))
    .rejects.toThrow('History object chunk did not advance.');
  expect(command.mock.calls.length).toBeLessThanOrEqual(65);
});

it('rejects an incomplete object with a declared byte length', async () => {
  const client = { historyCommand: vi.fn(async () => encode({ text: '{}', next: null })) } as unknown as RuntimeSidecarClient;
  await expect(hydrateHistoryValues(client, 's', [{ $historyObject: 'sha256:short', bytes: 20 }]))
    .rejects.toThrow('History object chunk is incomplete.');
});
