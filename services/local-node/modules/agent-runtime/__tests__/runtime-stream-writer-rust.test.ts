import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunStep, AgentRunStreamChunk } from '../contracts.js';
const transport = vi.hoisted(() => ({
  streamFence: vi.fn(async () => ({ epoch: 4, revision: 2 })),
  authoritativeRecordState: vi.fn(async () => ({ status: 'running', activeRunId: 'r', pendingResumeToken: null, blockedReason: null, updatedAt: 'now' })),
  appendStreamAuthoritative: vi.fn(async (_input: { producerSequence: number; chunks: AgentRunStreamChunk[] }) => 1),
  persistStreamHistory: vi.fn(async () => {}),
}));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: transport }));
vi.mock('../session-environment.js', () => ({ invalidateSessionEnvironment: vi.fn() }));
import { RuntimeStreamWriter, recordRuntimeStream } from '../runtime-stream-writer.js';
const run = { id: 'r', sessionId: 's', status: 'running' } as AgentRun;
const step = { id: 'step', runId: 'r', sessionId: 's', index: 1 } as AgentRunStep;
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it('writes ordered Rust batches and never selects the retired disabled transport', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'disabled');
  const writer = new RuntimeStreamWriter('s', 'r');
  writer.write({ type: 'run_started', run });
  writer.write({ type: 'step_started', step });
  await writer.settled();
  expect(transport.streamFence).toHaveBeenCalledTimes(1);
  expect(transport.appendStreamAuthoritative.mock.calls.map(args => (args[0] as { producerSequence: number }).producerSequence)).toEqual([1, 2]);
  expect(transport.persistStreamHistory).toHaveBeenCalledTimes(2);
});

it('coalesces eight deltas and flushes them before the next boundary', async () => {
  vi.useFakeTimers();
  const writer = new RuntimeStreamWriter('s', 'r');
  writer.write({ type: 'step_started', step });
  for (let index = 0; index < 8; index++) {
    writer.write({ type: 'message_delta', runId: 'r', stepId: step.id, delta: String(index) });
  }
  await writer.settled();
  expect(transport.appendStreamAuthoritative).toHaveBeenCalledTimes(2);
  expect((transport.appendStreamAuthoritative.mock.calls[1][0] as { chunks: AgentRunStreamChunk[] }).chunks).toHaveLength(8);
  writer.write({ type: 'tool_call', runId: 'r', stepId: step.id, toolCall: {} as never });
  await writer.settled();
  expect(transport.appendStreamAuthoritative).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});

it('flushes a short delta burst on the bounded timer', async () => {
  vi.useFakeTimers();
  const writer = new RuntimeStreamWriter('s', 'r');
  writer.write({ type: 'step_started', step });
  writer.write({ type: 'message_delta', runId: 'r', stepId: step.id, delta: 'a' });
  expect(transport.appendStreamAuthoritative).toHaveBeenCalledTimes(0);
  vi.advanceTimersByTime(40);
  await writer.settled();
  expect(transport.appendStreamAuthoritative).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('publishes interrupted assistant output and awaits that final write', async () => {
  async function* source(): AsyncGenerator<AgentRunStreamChunk> {
    yield { type: 'run_started', run };
    yield { type: 'step_started', step };
    yield { type: 'message_delta', runId: 'r', stepId: step.id, delta: 'retained partial' };
    yield { type: 'run_failed', run: { ...run, status: 'failed' }, error: 'provider stopped' };
  }
  for await (const _ of recordRuntimeStream('s', source())) { /* consume actual writer */ }
  expect(transport.persistStreamHistory).toHaveBeenLastCalledWith('s', [expect.objectContaining({
    type: 'message', message: expect.objectContaining({ content: 'retained partial', metadata: expect.objectContaining({ partial: true }) }),
  })], 1);
});

it('reports a failed Rust append at the completion boundary', async () => {
  transport.appendStreamAuthoritative.mockRejectedValueOnce(new Error('disk unavailable'));
  const writer = new RuntimeStreamWriter('s', 'r');
  writer.write({ type: 'run_started', run });
  await expect(writer.settled()).rejects.toThrow('disk unavailable');
  expect(transport.persistStreamHistory).not.toHaveBeenCalled();
});
