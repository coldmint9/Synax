/**
 * Runtime kernel benchmark: cold start / warm start for a session with N messages.
 *
 * Scope (deliberately narrow, so numbers stay comparable):
 *   - Measured: the Synax runtime kernel only — process boot (Node + Rust
 *     sidecar + session index) and loading one conversation into the execution
 *     working set (`AgentRuntimeStore.hydrateSession`, the gate that
 *     `run-admission` requires before a send can be accepted).
 *   - Not measured: client/browser work, HTTP transfer to a remote client, the
 *     LLM provider request, tool execution, and context compaction.
 *
 * Cold start  = fresh kernel process, first load of a session with N messages.
 * Warm start  = same kernel process, load of another N-message session (OS page
 *               cache, sidecar cache and Node heap already warm).
 * Cached open = re-open the already hydrated session (what a user sees when
 *               switching back to a conversation that is already in memory).
 *
 * The send path is probed with `POST /api/agent-runtime/sessions/:id/runs` and an
 * intentionally invalid body: the route-level middleware hydrates the working
 * set before the handler validates the body, so the request measures the real
 * pre-send gate and then returns 400 without creating a run, calling a model or
 * mutating the session.
 *
 * Kernel-side timings are read back from the runtime's own request log
 * (`GET /api/logs` -> `durationMs`), so client round-trip time is excluded.
 *
 * Usage:
 *   tsx scripts/runtime-kernel-benchmark.ts
 *   tsx scripts/runtime-kernel-benchmark.ts --sizes=100,1000,5000 --warm=3
 *   tsx scripts/runtime-kernel-benchmark.ts --target=source --rebuild
 *   tsx scripts/runtime-kernel-benchmark.ts --out=.tmp/perf/my-run
 *   tsx scripts/runtime-kernel-benchmark.ts --settle=1500 --sample=10 --keep
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type Options = {
  sizes: number[];
  warm: number;
  repeat: number;
  target: 'dist' | 'source';
  settleMs: number;
  sampleMs: number;
  rebuild: boolean;
  keep: boolean;
  out?: string;
};

function readOptions(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const sizes = (flag('sizes') ?? '100,1000,5000')
    .split(',')
    .map(value => Number(value.trim()));
  if (sizes.length === 0 || !sizes.every(value => Number.isInteger(value) && value > 0))
    throw new Error('--sizes must be a comma separated list of positive integers.');
  const warm = Number(flag('warm') ?? 3);
  if (!Number.isInteger(warm) || warm < 1 || warm > 30)
    throw new Error('--warm must be an integer between 1 and 30.');
  const repeat = Number(flag('repeat') ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 9)
    throw new Error('--repeat must be an integer between 1 and 9.');
  const target = (flag('target') ?? 'dist') as Options['target'];
  if (target !== 'dist' && target !== 'source') throw new Error('--target must be "dist" or "source".');
  const settleMs = Number(flag('settle') ?? 750);
  const sampleMs = Number(flag('sample') ?? 15);
  return {
    sizes,
    warm,
    repeat,
    target,
    settleMs,
    sampleMs,
    rebuild: argv.includes('--rebuild'),
    keep: argv.includes('--keep'),
    out: flag('out'),
  };
}

// ---------------------------------------------------------------------------
// Fixtures: a deterministic synthetic conversation
// ---------------------------------------------------------------------------

const USER_TEXT =
  'Review the runtime session loader and tell me which reads dominate the cold path. ' +
  'Focus on history paging, run/step joins and any repeated projections of the same records. ';
const ASSISTANT_TEXT =
  'The cold path walks the session once per collection. Message, part and event indexes are ' +
  'paged at 768 KiB, then each page is merged into the in-memory working set before the next ' +
  'collection starts. Runs and steps are small but they are read independently, so the cost ' +
  'scales with the number of turns rather than the transcript size alone. The loader publishes ' +
  'only after every collection resolved, which keeps readers from observing a half-loaded ' +
  'session. ';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const at = (index: number) => new Date(BASE_TIME + index * 1000).toISOString();

function makeSession(id: string, projectId: string, messages: number): Record<string, unknown> {
  return {
    id,
    runtimeRecoveryRequired: false,
    projectId,
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'completed',
    title: `Benchmark session (${messages} messages)`,
    prompt: 'Runtime kernel benchmark fixture.',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    reasoningEffort: null,
    permissionRules: [],
    createdAt: at(0),
    updatedAt: at(messages),
    completedAt: at(messages),
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
  };
}

/**
 * One message per turn index: user + assistant pairs, one run/step/part per
 * assistant turn and one event per message, which is roughly what a completed
 * conversation of N messages looks like in the runtime store.
 */
function conversationEntities(sessionId: string, messages: number): Array<{ kind: string; value: Record<string, unknown> }> {
  const objects: Array<{ kind: string; value: Record<string, unknown> }> = [];
  let produced = 0;
  for (let turn = 0; produced < messages; turn++) {
    const runId = `run-${sessionId}-${turn}`;
    const stepId = `step-${sessionId}-${turn}`;
    const userIndex = produced;
    objects.push({
      kind: 'runtime.message',
      value: {
        id: `msg-${sessionId}-${userIndex}`,
        sessionId,
        runId,
        stepId: null,
        role: 'user',
        content: USER_TEXT,
        contentParts: [{ type: 'text', text: USER_TEXT }],
        metadata: {},
        sequence: userIndex,
        createdAt: at(userIndex),
      },
    });
    produced += 1;
    if (produced >= messages) break;
    const replyIndex = produced;
    objects.push({
      kind: 'runtime.run',
      value: {
        id: runId,
        sessionId,
        status: 'completed',
        startedAt: at(replyIndex),
        completedAt: at(replyIndex),
        triggerMessageId: `msg-${sessionId}-${userIndex}`,
        currentStep: 1,
        stopReason: 'completed',
        model: 'benchmark-model',
        metadata: {},
      },
    });
    objects.push({
      kind: 'runtime.step',
      value: {
        id: stepId,
        runId,
        sessionId,
        index: 1,
        status: 'completed',
        model: 'benchmark-model',
        startedAt: at(replyIndex),
        completedAt: at(replyIndex),
        finishReason: 'stop',
        metadata: {},
      },
    });
    objects.push({
      kind: 'runtime.part',
      value: {
        id: `part-${sessionId}-${turn}`,
        runId,
        stepId,
        sessionId,
        kind: 'text',
        sequence: 1,
        content: ASSISTANT_TEXT,
        toolCallId: null,
        metadata: {},
        createdAt: at(replyIndex),
      },
    });
    objects.push({
      kind: 'runtime.message',
      value: {
        id: `msg-${sessionId}-${replyIndex}`,
        sessionId,
        runId,
        stepId,
        role: 'assistant',
        content: ASSISTANT_TEXT,
        contentParts: [{ type: 'text', text: ASSISTANT_TEXT }],
        metadata: {},
        sequence: replyIndex,
        createdAt: at(replyIndex),
      },
    });
    produced += 1;
    objects.push({
      kind: 'runtime.event',
      value: {
        id: `evt-${sessionId}-${turn}`,
        sessionId,
        runId,
        type: 'run_completed',
        timestamp: at(replyIndex),
        visibility: 'user_visible',
        summary: 'Run completed.',
        payload: {},
      },
    });
  }
  return objects;
}

/** Seed one session through the same history append path the runtime uses. */
async function seedSession(
  client: RuntimeSidecarClient,
  input: { sessionId: string; projectId: string; messages: number },
): Promise<{ entities: number; bytes: number }> {
  const session = makeSession(input.sessionId, input.projectId, input.messages);
  await client.seedUi(input.sessionId, Buffer.from(JSON.stringify(session)));
  const objects = conversationEntities(input.sessionId, input.messages);
  let batch: typeof objects = [];
  let batchBytes = 0;
  let bytes = Buffer.byteLength(JSON.stringify(session));
  let request = 0;
  const flush = async () => {
    if (!batch.length) return;
    batchBytes = 0;
    const payload = { objects: batch };
    const size = Buffer.byteLength(JSON.stringify(payload));
    await client.historyCommand({
      sessionId: input.sessionId,
      requestId: `seed-${input.sessionId}-${++request}`,
      operation: 'append_entities',
      payload,
    });
    bytes += size;
    batch = [];
  };
  for (const object of objects) {
    const size = Buffer.byteLength(JSON.stringify(object)) + 2;
    // The sidecar accepts 1..=256 entities per append command.
    if (batch.length >= 256 || batchBytes + size > 512 * 1024) await flush();
    batch.push(object);
    batchBytes += size;
  }
  await flush();
  return { entities: objects.length, bytes };
}

// ---------------------------------------------------------------------------
// Kernel process control
// ---------------------------------------------------------------------------

type Kernel = {
  child: ChildProcess;
  port: number;
  token: string;
  sidecarPid: number;
  baseUrl: string;
  spawnMs: number;
  output: () => string;
};

function kernelCommand(target: Options['target']): { command: string; args: string[] } {
  if (target === 'source')
    return { command: process.execPath, args: ['--import', 'tsx', 'services/local-node/entrypoints/http-server.ts'] };
  if (!existsSync(path.join(ROOT, 'server-dist/server.cjs')))
    throw new Error('server-dist/server.cjs is missing. Run `npm run build` or pass --target=source.');
  return { command: process.execPath, args: ['server-dist/server.cjs'] };
}

async function startKernel(target: Options['target'], dataRoot: string): Promise<Kernel> {
  const { command, args } = kernelCommand(target);
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_ROOT: dataRoot,
      PORT: '0',
      NODE_ENV: 'test',
      SYNAX_DESKTOP_SIDECAR: '1',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Kernel did not become ready.\n${buffer.slice(-4000)}`)), 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Kernel exited before READY (${code}).\n${buffer.slice(-4000)}`)); });
    const onData = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-200_000);
      const match = /^SYNAX_DESKTOP_READY:(\d+)$/m.exec(buffer);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
  });
  const spawnMs = performance.now() - started;
  const token = (await readFile(path.join(dataRoot, 'runtime-access-token'), 'utf8')).trim();
  const sidecarPid = Number(/sidecarPid":(\d+)/.exec(buffer)?.[1] ?? 0);
  return {
    child,
    port,
    token,
    sidecarPid,
    baseUrl: `http://127.0.0.1:${port}`,
    spawnMs,
    output: () => buffer,
  };
}

async function stopKernel(kernel: Kernel): Promise<void> {
  const { child } = kernel;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.kill('SIGTERM');
  await closed;
  clearTimeout(force);
}

/** RSS in MiB, or null when the process is gone. */
async function rssMb(pid: number): Promise<number | null> {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) ? Number((kb / 1024).toFixed(1)) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

type LoadSample = {
  serverMs: number | null;
  clientMs: number;
  status: number;
  kernelRssMb: number | null;
  sidecarRssMb: number | null;
  peakKernelRssMb: number | null;
  peakSidecarRssMb: number | null;
};

type SizeResult = {
  run: number;
  messages: number;
  entities: number;
  fixtureMb: number;
  sessionsSeeded: number;
  bootMs: number;
  baseline: { kernelRssMb: number | null; sidecarRssMb: number | null };
  cold: LoadSample;
  warm: LoadSample[];
  cached: LoadSample;
  /** PATCH /pin on a session that is not loaded: metadata only, no history. */
  pin: LoadSample;
  /** Resident size after every seeded session has been loaded once. */
  afterWarm: { kernelRssMb: number | null; sidecarRssMb: number | null; loadedSessions: number };
  projection: ProjectionSample;
};

/**
 * Cost of the send path itself, measured in this process after the kernel is
 * stopped: hydrating the session and building the model messages for one step,
 * which is what every model request repeats from scratch.
 */
type ProjectionSample = {
  projectionMs: number;
  projectionFirstMs: number;
  messageCount: number;
  runs: number;
  steps: number;
  listRunPartsMs: number;
  listRunStepsMs: number;
  legacyPartScanMs: number;
  parts: number;
};

async function apiGet(kernel: Kernel, route: string): Promise<Response> {
  return fetch(`${kernel.baseUrl}${route}`, {
    headers: { authorization: `Bearer ${kernel.token}` },
    signal: AbortSignal.timeout(120_000),
  });
}

/** Kernel-side duration of the newest request log entry for `path`. */
async function serverDuration(kernel: Kernel, pathname: string): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await apiGet(kernel, '/api/logs?limit=200');
      if (response.ok) {
        const body = (await response.json()) as {
          items?: Array<{ method?: string | null; path?: string | null; status?: number | null; durationMs?: number | null }>;
        };
        const match = (body.items ?? []).find(item =>
          item.method === 'POST' &&
          item.path === pathname &&
          typeof item.durationMs === 'number',
        );
        if (match && typeof match.durationMs === 'number') return match.durationMs;
      }
    } catch {
      // Kernel busy or shutting down; retry below.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

/** Probe the pre-send gate: hydrate the session, then fail schema validation. */
async function probeLoad(kernel: Kernel, sessionId: string, sampleMs: number): Promise<LoadSample> {
  const requestPath = `/api/agent-runtime/sessions/${sessionId}/runs`;
  let peakKernel: number | null = null;
  let peakSidecar: number | null = null;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [kernelRss, sidecarRss] = await Promise.all([rssMb(kernel.child.pid!), rssMb(kernel.sidecarPid)]);
      if (kernelRss !== null) peakKernel = Math.max(peakKernel ?? 0, kernelRss);
      if (sidecarRss !== null) peakSidecar = Math.max(peakSidecar ?? 0, sidecarRss);
      await new Promise(resolve => setTimeout(resolve, sampleMs));
    }
  })();
  const started = performance.now();
  const response = await fetch(`${kernel.baseUrl}${requestPath}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${kernel.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(120_000),
  });
  const clientMs = performance.now() - started;
  const body = await response.text();
  sampling = false;
  await sampler;
  const [kernelRss, sidecarRss] = await Promise.all([rssMb(kernel.child.pid!), rssMb(kernel.sidecarPid)]);
  // The probe must reach body validation; anything else means the gate under
  // test (hydration) failed instead of admitting a well-formed send.
  if (response.status !== 400 || !body.includes('Validation failed'))
    throw new Error(`Unexpected probe response ${response.status}: ${body.slice(0, 500)}`);
  return {
    serverMs: await serverDuration(kernel, requestPath),
    clientMs: Number(clientMs.toFixed(2)),
    status: response.status,
    kernelRssMb: kernelRss,
    sidecarRssMb: sidecarRss,
    peakKernelRssMb: peakKernel,
    peakSidecarRssMb: peakSidecar,
  };
}

/** Metadata mutation on a session whose history is not in the working set. */
async function probePin(kernel: Kernel, sessionId: string, sampleMs: number): Promise<LoadSample> {
  const requestPath = `/api/agent-runtime/sessions/${sessionId}/pin`;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await rssMb(kernel.child.pid!);
      await new Promise(resolve => setTimeout(resolve, sampleMs));
    }
  })();
  const started = performance.now();
  const response = await fetch(`${kernel.baseUrl}${requestPath}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${kernel.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const clientMs = performance.now() - started;
  const body = await response.text();
  sampling = false;
  await sampler;
  if (response.status !== 200)
    throw new Error(`Pin probe failed with ${response.status}: ${body.slice(0, 300)}`);
  const [kernelRss, sidecarRss] = await Promise.all([rssMb(kernel.child.pid!), rssMb(kernel.sidecarPid)]);
  return {
    serverMs: await serverDuration(kernel, requestPath),
    clientMs: Number(clientMs.toFixed(2)),
    status: response.status,
    kernelRssMb: kernelRss,
    sidecarRssMb: sidecarRss,
    peakKernelRssMb: kernelRss,
    peakSidecarRssMb: sidecarRss,
  };
}

async function seedRoot(
  dataRoot: string,
  input: { sizes: number[]; warm: number },
): Promise<Map<number, { entities: number; fixtureBytes: number; sessions: string[] }>> {
  const supervisor = new RustRuntimeSupervisor({ dataRoot });
  const result = new Map<number, { entities: number; fixtureBytes: number; sessions: string[] }>();
  let client: RuntimeSidecarClient | undefined;
  try {
    await supervisor.start();
    client = new RuntimeSidecarClient({
      socketPath: supervisor.socketPath,
      token: supervisor.token,
      requestTimeoutMs: 120_000,
      retryTimeoutMs: 180_000,
    });
    for (const size of input.sizes) {
      const projectId = 'benchmark-project';
      const sessions = Array.from({ length: input.warm + 1 }, (_, index) => `bench-${size}-${index}`);
      let entities = 0;
      let fixtureBytes = 0;
      for (const sessionId of sessions) {
        const seeded = await seedSession(client, { sessionId, projectId, messages: size });
        entities += seeded.entities;
        fixtureBytes += seeded.bytes;
      }
      result.set(size, { entities, fixtureBytes, sessions });
    }
  } finally {
    client?.close();
    await supervisor.stop();
  }
  return result;
}

async function measureSize(input: {
  size: number;
  run: number;
  warm: number;
  fixture: { entities: number; fixtureBytes: number; sessions: string[] };
  dataRoot: string;
  options: Options;
}): Promise<SizeResult> {
  const kernel = await startKernel(input.options.target, input.dataRoot);
  const [coldSession, ...warmSessions] = input.fixture.sessions;
  let measured: Omit<SizeResult, 'projection'>;
  try {
    // Cold = a fresh kernel that has just become ready. Give the background
    // session-index replay a moment so the load is not measured racing boot.
    await new Promise(resolve => setTimeout(resolve, input.options.settleMs));
    const baseline = {
      kernelRssMb: await rssMb(kernel.child.pid!),
      sidecarRssMb: await rssMb(kernel.sidecarPid),
    };
    const cold = await probeLoad(kernel, coldSession, input.options.sampleMs);
    // Measured before the warm loads so the session is still outside the
    // working set; the old code hydrated the whole transcript here.
    const pin = await probePin(kernel, warmSessions[0]!, input.options.sampleMs);
    const warm: LoadSample[] = [];
    for (const sessionId of warmSessions.slice(0, input.warm))
      warm.push(await probeLoad(kernel, sessionId, input.options.sampleMs));
    const afterWarm = {
      kernelRssMb: await rssMb(kernel.child.pid!),
      sidecarRssMb: await rssMb(kernel.sidecarPid),
      loadedSessions: warm.length + 1,
    };
    const cached = await probeLoad(kernel, coldSession, input.options.sampleMs);
    // Only meaningful while the session is still resident; with a small
    // working set the re-open is a real reload (and can be slower under GC).
    const workingSetLimit = Number(process.env.SYNAX_RUNTIME_WORKING_SET ?? 12);
    if (warm.length + 1 <= workingSetLimit &&
        (cached.serverMs ?? cached.clientMs) > (cold.serverMs ?? cold.clientMs))
      throw new Error('Re-opening a hydrated session was slower than the cold load.');
    measured = {
      run: input.run,
      messages: input.size,
      entities: input.fixture.entities,
      fixtureMb: Number((input.fixture.fixtureBytes / 1024 / 1024).toFixed(1)),
      sessionsSeeded: input.fixture.sessions.length,
      bootMs: Number(kernel.spawnMs.toFixed(1)),
      baseline,
      cold,
      warm,
      cached,
      pin,
      afterWarm,
    };
  } finally {
    await stopKernel(kernel);
  }
  return { ...measured, projection: await measureProjection(input.dataRoot, coldSession) };
}

/**
 * The probe runs in its own process: importing the runtime graph here would
 * compete with the kernel being measured and leak sidecar env vars into the
 * next spawn.
 */
async function measureProjection(dataRoot: string, sessionId: string): Promise<ProjectionSample> {
  // The kernel's sidecar exits with its parent; give the data root a moment to
  // release before the probe opens it.
  await new Promise(resolve => setTimeout(resolve, 300));
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'scripts/runtime-projection-probe.ts', dataRoot, sessionId],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 },
  );
  const line = /SYNAX_PROJECTION_RESULT:(\{.*\})/.exec(stdout);
  if (!line) throw new Error(`Projection probe returned no result.\n${stdout.slice(-4000)}`);
  return JSON.parse(line[1]!) as ProjectionSample;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

const round = (value: number | null, digits = 1): number | null =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

function summarize(results: SizeResult[]): Record<string, unknown>[] {
  const sizes = [...new Set(results.map(result => result.messages))].sort((a, b) => a - b);
  return sizes.map(messages => {
    const group = results.filter(result => result.messages === messages);
    const median = (values: number[]) => round(percentile(values, 0.5)) ?? 0;
    const coldMs = group.map(result => result.cold.serverMs ?? result.cold.clientMs);
    const warmAll = group.flatMap(result => result.warm.map(sample => sample.serverMs ?? sample.clientMs));
    const warmP50 = group.map(result => {
      const samples = result.warm.map(sample => sample.serverMs ?? sample.clientMs);
      return samples.length ? percentile(samples, 0.5) : 0;
    });
    const totalAfter = group.map(result => (result.cold.kernelRssMb ?? 0) + (result.cold.sidecarRssMb ?? 0));
    return {
      messages,
      runs: group.length,
      entities: group[0]!.entities,
      fixtureMb: group[0]!.fixtureMb,
      bootMs: median(group.map(result => result.bootMs)),
      coldLoadMs: median(coldMs),
      coldTotalMs: median(group.map(result => result.bootMs + (result.cold.serverMs ?? result.cold.clientMs))),
      warmP50Ms: median(warmP50),
      warmMinMs: warmAll.length ? Number(Math.min(...warmAll).toFixed(1)) : null,
      warmMaxMs: warmAll.length ? Number(Math.max(...warmAll).toFixed(1)) : null,
      cachedMs: median(group.map(result => result.cached.serverMs ?? result.cached.clientMs)),
      pinMs: median(group.map(result => result.pin.serverMs ?? result.pin.clientMs)),
      loadedSessions: group[0]!.afterWarm.loadedSessions,
      rssAfterWarmMb: median(group.map(result => (result.afterWarm.kernelRssMb ?? 0) + (result.afterWarm.sidecarRssMb ?? 0))),
      kernelBaseMb: median(group.map(result => result.baseline.kernelRssMb ?? 0)),
      sidecarBaseMb: median(group.map(result => result.baseline.sidecarRssMb ?? 0)),
      kernelAfterMb: median(group.map(result => result.cold.kernelRssMb ?? 0)),
      sidecarAfterMb: median(group.map(result => result.cold.sidecarRssMb ?? 0)),
      projectionMs: median(group.map(result => result.projection.projectionMs)),
      projectionFirstMs: median(group.map(result => result.projection.projectionFirstMs)),
      projectionSteps: group[0]!.projection.steps,
      projectionRuns: group[0]!.projection.runs,
      listRunPartsMs: median(group.map(result => result.projection.listRunPartsMs)),
      legacyPartScanMs: median(group.map(result => result.projection.legacyPartScanMs)),
      projectionParts: group[0]!.projection.parts,
      listRunStepsMs: median(group.map(result => result.projection.listRunStepsMs)),
      // A typical agent turn makes dozens of model requests; report a 30-step
      // turn so the estimate does not track the fixture's run/message ratio.
      projectedTurnMs: median(group.map(result => result.projection.projectionMs * 30)),
      totalAfterMb: median(totalAfter),
      loadDeltaMb: median(group.map(result =>
        (result.cold.kernelRssMb ?? 0) + (result.cold.sidecarRssMb ?? 0) -
        ((result.baseline.kernelRssMb ?? 0) + (result.baseline.sidecarRssMb ?? 0)))),
      peakTotalMb: median(group.map(result => Math.max(
        (result.cold.peakKernelRssMb ?? 0) + (result.cold.peakSidecarRssMb ?? 0),
        (result.cold.kernelRssMb ?? 0) + (result.cold.sidecarRssMb ?? 0),
      ))),
      bootTotalMb: median(group.map(result => (result.baseline.kernelRssMb ?? 0) + (result.baseline.sidecarRssMb ?? 0))),
    };
  });
}

function markdown(report: {
  environment: Record<string, unknown>;
  options: Options;
  rows: Record<string, unknown>[];
  results: SizeResult[];
}): string {
  const cell = (value: unknown) => (value === null || value === undefined ? '–' : String(value));
  const lines: string[] = [];
  lines.push('# Synax runtime kernel benchmark');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push('- Measured: runtime kernel boot (Node host + Rust sidecar + session index) and loading one conversation into the execution working set — the gate `run-admission` requires before a send is accepted.');
  lines.push('- Excluded: client/browser work, browser transport, the LLM provider request, tool execution and context compaction.');
  lines.push('- `cold` = fresh kernel process, first load of an N-message session. `warm` = same kernel process, first load of another N-message session. `cached` = re-opening the session that is already hydrated.');
  lines.push('- Kernel timings come from the runtime request log (`durationMs`), so the localhost round trip is not part of the number.');
  lines.push(`- Each cold boot idles ${report.options.settleMs} ms after READY so the background session-index replay settles before the load is timed; that idle is excluded from the load number and not part of \`cold total\`.`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  for (const [key, value] of Object.entries(report.environment)) lines.push(`- ${key}: ${String(value)}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Messages | Runs | Entities | Fixture | Cold total (ms) | Boot (ms) | Cold load (ms) | Warm p50 (ms) | Warm min/max (ms) | Cached (ms) | Pin (ms) | Kernel+sidecar RSS (MB) | Load delta (MB) | After all loads (MB) | Peak (MB) |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.rows) {
    lines.push(
      `| ${cell(row.messages)} | ${cell(row.runs)} | ${cell(row.entities)} | ${cell(row.fixtureMb)} MB | ${cell(row.coldTotalMs)} | ${cell(row.bootMs)} | ` +
      `${cell(row.coldLoadMs)} | ${cell(row.warmP50Ms)} | ${cell(row.warmMinMs)} / ${cell(row.warmMaxMs)} | ${cell(row.cachedMs)} | ${cell(row.pinMs)} | ` +
      `${cell(row.totalAfterMb)} | ${cell(row.loadDeltaMb)} | ${cell(row.rssAfterWarmMb)} (${cell(row.loadedSessions)}) | ${cell(row.peakTotalMb)} |`,
    );
  }
  lines.push('');
  lines.push('Send path (one history projection per model request, measured in-process):');
  lines.push('');
  lines.push('| Messages | Projection (ms) | First call (ms) | Runs | Steps | listRunParts p50 (ms) | same-call, legacy clone-all (ms) | Est. 30-step turn (s) |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.rows) {
    const turn = typeof row.projectedTurnMs === 'number' ? (row.projectedTurnMs / 1000).toFixed(1) : '–';
    lines.push(
      `| ${cell(row.messages)} | ${cell(row.projectionMs)} | ${cell(row.projectionFirstMs)} | ${cell(row.projectionRuns)} | ` +
      `${cell(row.projectionSteps)} | ${cell(row.listRunPartsMs)} | ${cell(row.legacyPartScanMs)} | ${turn} |`,
    );
  }
  lines.push('');
  lines.push('## Per-size detail');
  lines.push('');
  const sizes = [...new Set(report.results.map(result => result.messages))].sort((a, b) => a - b);
  for (const size of sizes) {
    const runs = report.results.filter(result => result.messages === size).sort((a, b) => a.run - b.run);
    const first = runs[0]!;
    lines.push(`### ${size} messages`);
    lines.push('');
    lines.push(`- Entities seeded: ${first.entities} (messages, runs, steps, parts, events) across ${first.sessionsSeeded} sessions; fixture ${first.fixtureMb} MB.`);
    lines.push(`- Runs measured: ${runs.length}.`);
    for (const result of runs) {
      lines.push(
        `- Run ${result.run}: boot ${result.bootMs} ms (kernel ${cell(result.baseline.kernelRssMb)} MB, sidecar ${cell(result.baseline.sidecarRssMb)} MB) · ` +
        `cold load ${cell(result.cold.serverMs)} ms kernel / ${cell(result.cold.clientMs)} ms observed · ` +
        `warm ${result.warm.map(sample => `${cell(sample.serverMs)} ms`).join(', ') || '–'} · ` +
        `cached ${cell(result.cached.serverMs)} ms · pin ${cell(result.pin.serverMs)} ms · ` +
        `after load kernel ${cell(result.cold.kernelRssMb)} MB + sidecar ${cell(result.cold.sidecarRssMb)} MB · ` +
        `projection ${cell(result.projection.projectionMs)} ms for ${result.projection.messageCount} messages.`,
      );
    }
    lines.push('');
  }
  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push(`tsx scripts/runtime-kernel-benchmark.ts --sizes=${report.options.sizes.join(',')} --warm=${report.options.warm} --repeat=${report.options.repeat} --target=${report.options.target}`);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  if (options.rebuild) {
    console.error('[kernel-benchmark] rebuilding server-dist…');
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  }
  const outDir = path.resolve(ROOT, options.out ?? `.tmp/performance-runtime-kernel/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outDir, { recursive: true });

  // Each size gets its own data root, so a cold boot never depends on fixtures
  // of the other sizes.
  const results: SizeResult[] = [];
  for (const size of options.sizes) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), `synax-kernel-data-${size}-`));
    try {
      console.error(`[kernel-benchmark] seeding ${size} messages…`);
      const fixture = (await seedRoot(dataRoot, { sizes: [size], warm: options.warm })).get(size)!;
      for (let run = 1; run <= options.repeat; run++) {
        console.error(`[kernel-benchmark] measuring ${size} messages (run ${run}/${options.repeat})…`);
        results.push(await measureSize({ size, run, warm: options.warm, fixture, dataRoot, options }));
      }
    } finally {
      if (options.keep) console.error(`[kernel-benchmark] kept data root ${dataRoot}`);
      else await rm(dataRoot, { recursive: true, force: true });
    }
  }

  const environment = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    synaxVersion: (await readFile(path.join(ROOT, '.env.version'), 'utf8')).split('=').pop()?.trim() ?? 'unknown',
    target: options.target,
    warmSamples: options.warm,
    settleMsPerSize: options.settleMs,
  };
  const rows = summarize(results);
  const report = { environment, options, rows, results };
  await writeFile(path.join(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  const body = markdown(report);
  await writeFile(path.join(outDir, 'report.md'), `${body}\n`);
  console.log(body);
  console.error(`[kernel-benchmark] wrote ${path.relative(ROOT, outDir)}/report.md and result.json`);
}

await main();
