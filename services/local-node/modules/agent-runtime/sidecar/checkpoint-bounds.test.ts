import { expect, it, vi } from 'vitest';
import { RuntimeFacade } from './runtime-facade.js';
import { RuntimeSidecarError, type RuntimeSidecarClient } from './sidecar-client.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it('reads only the first and last message even when following a live cursor would conflict', async () => {
  const historyCommand = vi.fn(async (input: { operation: string; payload: { cursor?: unknown; reverse?: boolean; limit?: number } }) => {
    if (input.payload.cursor) throw new RuntimeSidecarError({ type: 'error', code: 'REVISION_CONFLICT', message: 'history advanced' });
    expect(input.operation).toBe('list_messages');
    expect(input.payload.limit).toBe(1);
    return encode({ items: [{ id: input.payload.reverse ? 'last' : 'first' }], cursor: { revision: 42, after: 'more' } });
  });
  const facade = new RuntimeFacade(() => ({ historyCommand }) as unknown as RuntimeSidecarClient);
  expect(await facade.messageHistoryBoundsAuthoritative('s')).toEqual({ firstMessageId: 'first', lastMessageId: 'last' });
  expect(historyCommand).toHaveBeenCalledTimes(2);
});

it('handles an empty transcript without inventing a message boundary', async () => {
  const historyCommand = vi.fn(async () => encode({ items: [] }));
  const facade = new RuntimeFacade(() => ({ historyCommand }) as unknown as RuntimeSidecarClient);
  expect(await facade.messageHistoryBoundsAuthoritative('s')).toEqual({ firstMessageId: undefined, lastMessageId: undefined });
});

it('hydrates a referenced boundary without reading the remaining history pages', async () => {
  const message = { id: 'large', content: '正文🙂'.repeat(200_000) };
  const bytes = Buffer.from(JSON.stringify(message));
  const historyCommand = vi.fn(async (input: { operation: string; payload: { cursor?: unknown; offset?: number } }) => {
    if (input.payload.cursor) throw new Error('must not follow boundary cursor');
    if (input.operation === 'list_messages') return encode({ items: [{ $historyObject: 'sha256:large', bytes: bytes.length }], cursor: { after: 'more' } });
    const offset = input.payload.offset ?? 0;
    let end = Math.min(offset + 65_536, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return encode({ text: bytes.subarray(offset, end).toString('utf8'), next: end < bytes.length ? end : null });
  });
  const facade = new RuntimeFacade(() => ({ historyCommand }) as unknown as RuntimeSidecarClient);
  expect(await facade.messageHistoryBoundsAuthoritative('s')).toEqual({ firstMessageId: 'large', lastMessageId: 'large' });
  expect(historyCommand.mock.calls.filter(([input]) => input.operation === 'list_messages')).toHaveLength(2);
});

it('propagates storage errors from boundary reads', async () => {
  const historyCommand = vi.fn().mockRejectedValue(new RuntimeSidecarError({ type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'storage unavailable' }));
  const facade = new RuntimeFacade(() => ({ historyCommand }) as unknown as RuntimeSidecarClient);
  await expect(facade.messageHistoryBoundsAuthoritative('s')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});
