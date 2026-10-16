import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const sessions = Number(process.env.SYNAX_RUNTIME_BENCH_SESSIONS ?? 100);
const batches = Number(process.env.SYNAX_RUNTIME_BENCH_BATCHES ?? 32);
const payloadBytes = Number(process.env.SYNAX_RUNTIME_BENCH_PAYLOAD_BYTES ?? 4096);
if (![sessions, batches, payloadBytes].every(value => Number.isInteger(value) && value > 0)) throw new Error('Benchmark parameters must be positive integers.');

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-benchmark-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: RuntimeSidecarClient | undefined;
const latencies: number[] = [];
const measure = async <T>(operation: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await operation();
  latencies.push(performance.now() - start);
  return result;
};
const percentile = (value: number): number => {
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1);
  return sorted[index] ?? 0;
};
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token, requestTimeoutMs: 30_000, retryTimeoutMs: 60_000 });
  const encoder = new TextEncoder();
  const delta = 'x'.repeat(payloadBytes);
  await Promise.all(Array.from({ length: sessions }, async (_, index) => {
    const sessionId = `bench-session-${index}`;
    await client!.seedUi(sessionId, encoder.encode(JSON.stringify({ id: sessionId, projectId: 'benchmark', status: 'queued', updatedAt: new Date().toISOString() })));
    await measure(() => client!.admitRun({ sessionId, requestId: `bench-admit-${index}`, bodyHash: `body-${index}`, runId: `bench-run-${index}`, epoch: 1, revision: 0 }));
    const admitted = await client!.snapshot(sessionId);
    await measure(() => client!.activateRun({ sessionId, requestId: `bench-activate-${index}`, epoch: admitted.epoch, revision: admitted.revision, run: { id: `bench-run-${index}`, sessionId, status: 'queued', startedAt: new Date().toISOString(), completedAt: null, metadata: {} } }));
    for (let batch = 1; batch <= batches; batch++) {
      const events = batch === 1
        ? [{ kind: 'step_started', payload: encoder.encode(JSON.stringify({ schema: 1, chunk: { type: 'step_started', sessionId, runId: `bench-run-${index}`, step: { id: 'bench-step', sessionId, runId: `bench-run-${index}`, index: 1 } }, state: { status: 'running', activeRunId: `bench-run-${index}`, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() } })) }]
        : [{ kind: 'message_delta', payload: encoder.encode(JSON.stringify({ schema: 1, chunk: { type: 'message_delta', sessionId, runId: `bench-run-${index}`, stepId: 'bench-step', delta }, state: { status: 'running', activeRunId: `bench-run-${index}`, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() } })) }];
      await measure(() => client!.appendStream({ sessionId, runId: `bench-run-${index}`, producerId: `bench-producer-${index}`, producerSequence: batch, epoch: 1, revision: admitted.revision, durability: 'group_commit', events }));
    }
    const fence = await client!.snapshot(sessionId);
    await measure(() => client!.finishRun({ sessionId, requestId: `bench-finish-${index}`, runId: `bench-run-${index}`, status: 'completed', epoch: fence.epoch, revision: fence.revision, run: { id: `bench-run-${index}`, sessionId, status: 'completed', completedAt: new Date().toISOString(), metadata: {} } }));
  }));
  const health = await client.health();
  assert.equal(health.ok, true);
  console.log(JSON.stringify({ sessions, batchesPerSession: batches, payloadBytes, operations: latencies.length,
    p50Ms: Number(percentile(0.50).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)), p99Ms: Number(percentile(0.99).toFixed(3)),
    maxMs: Number(Math.max(...latencies).toFixed(3)), generation: supervisor.generation }, null, 2));
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
