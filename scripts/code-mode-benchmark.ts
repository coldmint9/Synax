/** Compare cold and reused Code Mode threads in separate processes.
 * node --import tsx/esm scripts/code-mode-benchmark.ts --runs=100
 * node --import tsx/esm scripts/code-mode-benchmark.ts --runs=400 --concurrency=8 --idle-limit=2
 * Uses synthetic JSON/RPC work, no providers, credentials or workspace writes. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { executeCode } from "../services/local-node/modules/agent-runtime/code-mode/executor.js";
import { CodeWorkerPool } from "../services/local-node/modules/agent-runtime/code-mode/worker-pool.js";
import { CODE_WORKER_REUSE } from "../services/local-node/modules/agent-runtime/code-mode/contracts.js";

const runs = Number(process.argv.find(arg => arg.startsWith("--runs="))?.slice(7) ?? 100);
if (!Number.isSafeInteger(runs) || runs < 10 || runs > 10_000) throw new Error("--runs must be 10–10000.");
const concurrency = Number(process.argv.find(arg => arg.startsWith("--concurrency="))?.slice(14) ?? 1);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("--concurrency must be 1–16.");
const maxIdle = Number(process.argv.find(arg => arg.startsWith("--idle-limit="))?.slice(13) ?? CODE_WORKER_REUSE.idle);
if (!Number.isSafeInteger(maxIdle) || maxIdle < 1 || maxIdle > 2) throw new Error("--idle-limit must be 1 or 2.");
const mode = process.argv.find(arg => arg.startsWith("--mode="))?.slice(7);
if (!mode) {
  for (const selected of ["cold", "reuse"]) {
    const result = await promisify(execFile)(process.execPath,
      ["--expose-gc", "--import", "tsx/esm", fileURLToPath(import.meta.url), `--mode=${selected}`, `--runs=${runs}`, `--concurrency=${concurrency}`, `--idle-limit=${maxIdle}`],
      { timeout: runs * 2_000 + 30_000 });
    process.stdout.write(result.stdout);
  }
} else {
  if (!["cold", "reuse"].includes(mode)) throw new Error("--mode must be cold or reuse.");
  const pool = new CodeWorkerPool({ maxIdle: mode === "cold" ? 0 : maxIdle });
  const times: number[] = [];
  globalThis.gc?.();
  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  const cpu = process.cpuUsage();
  try {
    const execute = async () => {
      const start = performance.now();
      const result = await executeCode({
        code: 'const rows=await Promise.all([tools.call("read",{n:1}),tools.call("read",{n:2})]);return rows.reduce((a,b)=>a+b,0);',
        canParallelTool: () => true,
        callTool: async (_id, args) => {
          if (concurrency > 1) await new Promise(resolve => setTimeout(resolve, 2));
          return args.n;
        },
      }, pool);
      if (result.status !== "completed" || result.value !== 3) throw new Error(JSON.stringify(result));
      times.push(performance.now() - start);
    };
    for (let i = 0; i < runs; i += concurrency)
      await Promise.all(Array.from({ length: Math.min(concurrency, runs - i) }, execute));
    const used = process.cpuUsage(cpu);
    clearInterval(sample);
    const afterRuns = pool.snapshot();
    const endRss = process.memoryUsage().rss;
    // Verify actual idle expiry rather than treating close() as idle eviction.
    if (mode === "reuse") await new Promise(resolve => setTimeout(resolve, CODE_WORKER_REUSE.idleTimeoutMs + 200));
    globalThis.gc?.();
    const afterIdle = pool.snapshot();
    if (afterIdle.workers !== 0) throw new Error("Idle workers were not reclaimed.");
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ mode, runs, concurrency, maxIdle: mode === "cold" ? 0 : maxIdle, p50Ms: times[Math.floor((runs - 1) * 0.5)],
      p95Ms: times[Math.floor((runs - 1) * 0.95)], cpuMs: (used.user + used.system) / 1000,
      startRss, peakRss, endRss, afterIdleRss: process.memoryUsage().rss, afterRuns, afterIdle }));
  } finally { clearInterval(sample); await pool.close(); }
}
