import { afterEach, expect, it, vi } from 'vitest';
import { inputQueueRuntime } from '../input-queue-runtime.js';
import { inputQueueService } from '../input-queue-service.js';
import { runtimeFacade } from '../sidecar/runtime-facade.js';
import { agentRuntimeStore } from '../session-store.js';
const item = { id: 'q', message: 'steer', enqueuedAt: '2026-10-16T00:00:00Z' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('authoritative reads and mutations use Rust without synchronous queue metadata writes', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const write = vi.spyOn(agentRuntimeStore, 'updateSessionMetadata').mockImplementation(() => { throw new Error('unexpected legacy write'); });
  const read = vi.spyOn(runtimeFacade, 'queueSnapshot').mockResolvedValue({ items: [item], forceInjectItemId: null, revision: 1 });
  const mutation = vi.spyOn(runtimeFacade, 'queueMutation').mockResolvedValue(new TextEncoder().encode(JSON.stringify({ items: [], forceInjectItemId: null, revision: 2 })));
  expect(await inputQueueRuntime.list('s')).toEqual([item]);
  expect(await inputQueueRuntime.remove('s', 'q')).toEqual([]);
  expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', operation: 'remove', payload: { id: 'q' } }));
  expect(read).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
  expect(() => inputQueueService.list('s')).toThrow('Synchronous SQLite');
});
it('propagates Rust failure and never falls back to the metadata queue', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const legacy = vi.spyOn(inputQueueService, 'list');
  vi.spyOn(runtimeFacade, 'queueSnapshot').mockRejectedValue(new Error('disk unavailable'));
  await expect(inputQueueRuntime.list('s')).rejects.toThrow('disk unavailable');
  expect(legacy).not.toHaveBeenCalled();
});
it('retries a durable forced delivery after a message write interruption', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  vi.spyOn(runtimeFacade, 'queueSnapshot').mockResolvedValue({ items: [], forceInjectItemId: null, revision: 4, delivery: { runId: 'r', item } });
  const mutate = vi.spyOn(runtimeFacade, 'queueMutation').mockResolvedValue(new TextEncoder().encode(JSON.stringify({ items: [], forceInjectItemId: null, revision: 5 })));
  expect(await inputQueueRuntime.getForceInjectId('s')).toBe('q');
  expect(await inputQueueRuntime.consumeForced('s', 'r')).toEqual(item);
  await expect(inputQueueRuntime.consumeForced('s', 'other')).rejects.toThrow('previous run');
  expect(mutate).not.toHaveBeenCalled();
  await inputQueueRuntime.acknowledgeConsumption('s', 'r', 'q');
  expect(mutate).toHaveBeenCalledWith({ sessionId: 's', requestId: 'ack-inject:r:q', operation: 'ack_consume', payload: { id: 'q', runId: 'r' } });
});
