import { describe, expect, it } from 'vitest';
import { StreamByteBudget, StreamQueue, streamChunkBytes } from '../stream-queue.js';
import type { AgentRunStreamChunk } from '../contracts.js';
import { WorkerStreamCredits } from '../../../infrastructure/runtime/ipc/stream-credit.js';

const chunk = { type: 'message_delta', runId: 'r', stepId: 's', delta: 'hello' } as AgentRunStreamChunk;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('bounded worker stream delivery', () => {
  it('waits for consumption before granting another byte reservation', async () => {
    const size = streamChunkBytes(chunk);
    const global = new StreamByteBudget(size);
    const queue = new StreamQueue(global, size);
    await queue.reserve('first', size);
    queue.push({ kind: 'chunk', chunk }, 'first');
    let granted = false;
    const waiting = queue.reserve('second', size).then(() => { granted = true; });
    await tick(); expect(granted).toBe(false); expect(global.used).toBe(size);
    expect(await queue.next()).toEqual({ kind: 'chunk', chunk });
    await waiting; expect(global.used).toBe(size);
    queue.dispose(); expect(global.used).toBe(0);
  });
  it('shares the global byte budget across streams and releases cancelled waiters', async () => {
    const size = streamChunkBytes(chunk);
    const global = new StreamByteBudget(size);
    const first = new StreamQueue(global, size), second = new StreamQueue(global, size);
    await first.reserve('first', size);
    const waiting = second.reserve('second', size);
    const rejected = expect(waiting).rejects.toThrow('closed');
    await tick(); second.dispose(); await rejected;
    expect(global.used).toBe(size); first.dispose(); expect(global.used).toBe(0);
    const third = new StreamQueue(global, size); await third.reserve('third', size); third.dispose();
    expect(global.used).toBe(0);
  });
  it('rejects oversized events explicitly and retains terminal ordering', async () => {
    const size = streamChunkBytes(chunk);
    const global = new StreamByteBudget(size);
    const queue = new StreamQueue(global, size);
    await expect(queue.reserve('oversized', size + 1)).rejects.toThrow('exceeds');
    await queue.reserve('first', size); queue.push({ kind: 'chunk', chunk }, 'first');
    queue.push({ kind: 'done' }); queue.close();
    expect((await queue.next()).kind).toBe('chunk'); expect((await queue.next()).kind).toBe('done');
    expect(global.used).toBe(0);
  });
  it('bounds direct delivery from embedded hosts too', () => {
    const size = streamChunkBytes(chunk);
    const global = new StreamByteBudget(size), queue = new StreamQueue(global, size);
    queue.push({ kind: 'chunk', chunk });
    expect(() => queue.push({ kind: 'chunk', chunk })).toThrow('budget');
    queue.dispose(); expect(global.used).toBe(0);
  });
  it('does not send a payload before credit, and cancellation interrupts credit waiting', async () => {
    const credits = new WorkerStreamCredits(), signal = new AbortController();
    let id = '', granted = false;
    const waiting = credits.reserve('stream', chunk, signal.signal, request => { id = request.deliveryId; return true; })
      .then(value => { granted = true; return value; });
    await tick(); expect(granted).toBe(false);
    credits.grant(id); expect(await waiting).toBe(id);
    const pending = credits.reserve('stream', chunk, signal.signal, () => true);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    signal.abort(new Error('cancelled')); await rejected;
  });
});
