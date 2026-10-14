import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionLog } from '../services/local-node/infrastructure/storage/session-log.js';

// Synthetic durable-log benchmark. This does not claim end-to-end model/tool
// throughput, and never opens or migrates a user's data directory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-log-benchmark-'));
try {
  const result = [];
  for (const concurrency of [1, 8, 32, 64]) {
    const log = new SessionLog(path.join(root, String(concurrency)));
    const durations: number[] = [];
    const iterations = 30;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async (_, session) => {
      for (let n = 0; n < iterations; n++) {
        const start = performance.now();
        await log.append(`s${session}`, `r${n}`, [{ type: 'delta', payload: 'x'.repeat(1024) }]);
        durations.push(performance.now() - start);
      }
    }));
    const elapsed = performance.now() - started;
    durations.sort((a, b) => a - b);
    const quantile = (fraction: number) => Number(durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))].toFixed(2));
    result.push({ concurrency, commits: concurrency * iterations, elapsedMs: Math.round(elapsed), commitsPerSecond: Math.round(concurrency * iterations / elapsed * 1000), p50Ms: quantile(.5), p95Ms: quantile(.95), p99Ms: quantile(.99) });
    await log.close();
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, node: process.version, durability: 'file fsync; directory fsync on create/rotate (Unix)', payloadBytes: 1024, synthetic: true, result }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
