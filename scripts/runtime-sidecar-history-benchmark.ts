import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const settings = {
  sessions: Number(process.env.SYNAX_HISTORY_BENCH_SESSIONS ?? 100),
  concurrency: Number(process.env.SYNAX_HISTORY_BENCH_CONCURRENCY ?? 32),
  batches: Number(process.env.SYNAX_HISTORY_BENCH_BATCHES ?? 16),
  entitiesPerBatch: Number(process.env.SYNAX_HISTORY_BENCH_ENTITIES ?? 8),
  payloadBytes: Number(process.env.SYNAX_HISTORY_BENCH_PAYLOAD_BYTES ?? 512),
};
assert(Object.values(settings).every(value => Number.isSafeInteger(value) && value > 0), 'Benchmark parameters must be positive integers.');
assert(settings.concurrency <= 64 && settings.entitiesPerBatch <= 256, 'Respect the client concurrency and history batch budgets.');
assert(settings.entitiesPerBatch * (settings.payloadBytes + 512) <= 768 * 1024, 'A batch must fit in the control frame budget.');
const root = await mkdtemp(path.join(tmpdir(), 'synax-history-benchmark-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
const samples = { append: [] as number[], query: [] as number[] };
let client: RuntimeSidecarClient | undefined;
let request = 0;
async function command(sessionId: string, operation: string, payload: unknown, kind: keyof typeof samples) {
  const start = performance.now();
  const result = await client!.historyCommand({ sessionId, requestId: `history-bench:${++request}`, operation, payload });
  samples[kind].push(performance.now() - start);
  return JSON.parse(Buffer.from(result).toString('utf8'));
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(3));
  return { operations: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: percentile(1) };
};
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const content = 'x'.repeat(settings.payloadBytes);
  const start = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(settings.sessions, settings.concurrency) }, async () => {
    while (next < settings.sessions) {
      const sessionId = `history-bench-${next++}`;
      for (let batch = 0; batch < settings.batches; batch++) {
        await command(sessionId, 'append_entities', { objects: Array.from({ length: settings.entitiesPerBatch }, (_, offset) => {
          const sequence = batch * settings.entitiesPerBatch + offset;
          return { kind: 'runtime.message', value: { id: `m-${sequence}`, sessionId, sequence, content } };
        }) }, 'append');
      }
      await command(sessionId, 'append_entities', { objects: [{ kind: 'runtime.message', value: {
        id: 'm-0', sessionId, sequence: 0, content: 'updated',
      } }] }, 'append');
      const items: Array<{sequence: number; content: string}> = [];
      let cursor: unknown;
      do {
        const result = await command(sessionId, 'list_messages', {cursor}, 'query');
        items.push(...result.items); cursor = result.cursor;
      } while (cursor);
      assert.equal(items.length, settings.batches * settings.entitiesPerBatch);
      assert.equal(items[0].content, 'updated');
      assert.deepEqual(items.map(item => item.sequence),
        Array.from({ length: settings.batches * settings.entitiesPerBatch }, (_, i) => i));
    }
  }));
  const seconds = (performance.now() - start) / 1000;
  assert.equal((await client.health()).ok, true);
  console.log(JSON.stringify({ scope: 'runtime-history IPC (includes Node snapshot round trip; not full provider execution)',
    platform: `${process.platform}-${process.arch}`, ...settings,
    canonicalEntities: settings.sessions * settings.batches * settings.entitiesPerBatch,
    elapsedSeconds: Number(seconds.toFixed(3)),
    appendCommandsPerSecond: Number((samples.append.length / seconds).toFixed(1)),
    append: distribution(samples.append), query: distribution(samples.query),
    generation: supervisor.generation,
  }, null, 2));
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
