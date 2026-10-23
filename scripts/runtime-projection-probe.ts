/**
 * In-process probe for the runtime send path.
 *
 * Boots the Rust sidecar on an existing data root, hydrates one session into
 * the execution working set and measures one history projection (the work every
 * model request repeats) plus the per-step reads it depends on.
 *
 * Run indirectly from `scripts/runtime-kernel-benchmark.ts`; prints a single
 * `SYNAX_PROJECTION_RESULT:{...}` line on stdout because the runtime logger also
 * writes to stdout.
 */
import { performance } from 'node:perf_hooks';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { buildLoopModelMessages } from '../services/local-node/modules/agent-runtime/loop-model-messages.js';
import { agentRuntimeStore } from '../services/local-node/modules/agent-runtime/session-store.js';

const [dataRoot, sessionId] = process.argv.slice(2);
if (!dataRoot || !sessionId) throw new Error('Usage: runtime-projection-probe <dataRoot> <sessionId>');

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
};
const timeCalls = (calls: Array<() => unknown>) => {
  if (!calls.length) return 0;
  const timings = calls.map(call => {
    const started = performance.now();
    call();
    return performance.now() - started;
  });
  return Number(percentile(timings, 0.5).toFixed(3));
};

agentRuntimeStore.reset();
const supervisor = new RustRuntimeSupervisor({ dataRoot });
await supervisor.start();
try {
  await agentRuntimeStore.hydrateSession(sessionId);
  const runs = agentRuntimeStore.listRuns(sessionId);
  const steps = runs.flatMap(run => agentRuntimeStore.listRunSteps(run.id));
  const toolSet = {
    resolveModelToolName: (id: string) => id,
    resolveHistoricalModelToolName: (id: string) => id,
  };
  const samples: number[] = [];
  let first = 0;
  let messageCount = 0;
  for (let index = 0; index < 3; index++) {
    const started = performance.now();
    const messages = buildLoopModelMessages(agentRuntimeStore, sessionId, toolSet, {
      includeHistoricalRuntimeReminders: true,
    });
    const elapsed = performance.now() - started;
    if (index === 0) first = elapsed;
    messageCount = messages.length;
    samples.push(elapsed);
  }
  // Same-moment A/B for the clone-before-filter fix: the legacy variant clones
  // every part of the session and then filters, which is what the store used to
  // do on every step. Measuring both here keeps the ratio independent of how
  // busy the machine is.
  const allParts = steps.flatMap(step => agentRuntimeStore.listRunParts(step.id));
  const targetStep = steps[Math.floor(steps.length / 2)]?.id;
  const legacySamples: number[] = [];
  if (targetStep && allParts.length) {
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      allParts.map(part => structuredClone(part)).filter(part => part.stepId === targetStep);
      legacySamples.push(performance.now() - started);
    }
  }
  const result = {
    projectionMs: Number(percentile(samples, 0.5).toFixed(1)),
    projectionFirstMs: Number(first.toFixed(1)),
    messageCount,
    runs: runs.length,
    steps: steps.length,
    listRunPartsMs: timeCalls(steps.slice(0, 40).map(step => () => agentRuntimeStore.listRunParts(step.id))),
    listRunStepsMs: timeCalls(runs.slice(0, 40).map(run => () => agentRuntimeStore.listRunSteps(run.id))),
    legacyPartScanMs: Number(percentile(legacySamples, 0.5).toFixed(3)),
    parts: allParts.length,
  };
  process.stdout.write(`SYNAX_PROJECTION_RESULT:${JSON.stringify(result)}\n`);
} finally {
  await supervisor.stop();
  agentRuntimeStore.reset();
  process.exit(0);
}
