import { afterEach, expect, it, vi } from 'vitest';
const sidecar = vi.hoisted(() => ({
  streamFence: vi.fn(async () => ({ epoch: 1, revision: 0 })),
  authoritativeRecordState: vi.fn(async () => ({ status: 'running', activeRunId: 'r', pendingResumeToken: null, blockedReason: null, updatedAt: 'now' })),
  appendStreamAuthoritative: vi.fn(async (_input: { producerSequence: number }) => 17),
  persistStreamHistory: vi.fn(async () => {}),
  uiSnapshotAuthoritative: vi.fn(),
  replayAuthoritative: vi.fn(),
}));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: sidecar }));
import { runtimeJournal } from '../runtime-journal.js';
afterEach(() => vi.clearAllMocks());
it('serializes concurrent producer writes and persists history before acknowledging', async () => {
  const chunk = { type: 'message_delta' as const, runId: 'r', stepId: 'step', delta: 'hello' };
  await Promise.all([runtimeJournal.appendDurable('s', 'r', [chunk]), runtimeJournal.appendDurable('s', 'r', [chunk])]);
  expect(sidecar.appendStreamAuthoritative.mock.calls.map(([input]) => input.producerSequence)).toEqual([1, 2]);
  expect(sidecar.persistStreamHistory).toHaveBeenCalledTimes(2);
});
it('propagates a durable append failure rather than producing a Node replay record', async () => {
  sidecar.appendStreamAuthoritative.mockRejectedValueOnce(new Error('Rust offline'));
  await expect(runtimeJournal.appendDurable('failed', 'r', [{ type: 'done', sessionId: 'failed', runId: 'r' }])).rejects.toThrow('Rust offline');
  expect(sidecar.persistStreamHistory).not.toHaveBeenCalled();
});
it('has no synchronous replay backend', () => {
  for (const name of ['append', 'appendBatch', 'read', 'cursor', 'snapshot']) expect(runtimeJournal).not.toHaveProperty(name);
});
