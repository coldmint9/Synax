import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'synax-runtime-worker-authoritative-'));
const socketPath = join(root, 'runtime.sock');
const hotPath = join(root, 'runtime-hot');
const binary = join(process.cwd(), 'runtime-sidecar', 'target', 'release', process.platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar');
const token = 'worker-authoritative-smoke-token';
process.env.DATA_ROOT = join(root, 'node-data');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.SYNAX_HISTORY_MODE = 'flat';
process.env.SYNAX_TRANSCRIPT_STORAGE = 'legacy';
process.env.SYNAX_RUNTIME_SIDECAR_STREAM = 'authoritative';
process.env.SYNAX_RUNTIME_SIDECAR_SOCKET = socketPath;
process.env.SYNAX_RUNTIME_SIDECAR_TOKEN = token;

const child = spawn(binary, [], {
  env: {
    ...process.env,
    SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
    SYNAX_RUNTIME_SIDECAR_TOKEN: token,
    SYNAX_RUNTIME_HOT_PATH: hotPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const cleanup = () => {
  if (child.exitCode === null) child.kill('SIGKILL');
  try { unlinkSync(socketPath); } catch {}
  rmSync(root, { recursive: true, force: true });
};
process.once('exit', cleanup);

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar READY timeout')), 10_000);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split('\n').find((value) => value.startsWith('SYNAX_RUNTIME_READY:'));
      if (!line) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`sidecar exited before READY (${code})`)));
  });

  const { agentSessionRuntime } = await import('../services/local-node/modules/agent-runtime/session-runtime.ts');
  const { agentRuntimeStore } = await import('../services/local-node/modules/agent-runtime/session-store.ts');
  const { recordRuntimeStream } = await import('../services/local-node/modules/agent-runtime/runtime-stream-writer.ts');
  const { runtimeFacade } = await import('../services/local-node/modules/agent-runtime/sidecar/runtime-facade.ts');
  const { plannerSessionInput, resetAgentRuntimeFixtures } = await import('../services/local-node/modules/agent-runtime/__tests__/agent-runtime-fixtures.ts');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create(plannerSessionInput);
  const run = agentRuntimeStore.appendRun({
    id: `worker-run-${session.id}`,
    sessionId: session.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    triggerMessageId: null,
    currentStep: 0,
    stopReason: null,
    model: null,
    metadata: {},
  });
  agentRuntimeStore.updateSession(session.id, { activeRunId: run.id, status: 'running' });
  const { RuntimeSidecarClient } = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.ts');
  const client = new RuntimeSidecarClient({ socketPath, token });
  try {
    await client.admitRun({ sessionId: session.id, requestId: 'start', bodyHash: 'body', runId: run.id, epoch: 1, revision: 0 });
  } finally { client.close(); }


  async function* source() {
    yield { type: 'run_started', run } as const;
    yield { type: 'message_delta', runId: run.id, stepId: 'worker-step', delta: 'worker output' } as const;
    yield { type: 'done', sessionId: session.id, runId: run.id } as const;
  }
  const observed = [];
  for await (const chunk of recordRuntimeStream(session.id, source())) observed.push(chunk);
  const replay = await runtimeFacade.replayAuthoritative(session.id, 0, run.id);
  if (observed.length !== 3) throw new Error(`worker source observed ${observed.length} chunks`);
  if (replay.length !== 3) throw new Error(`sidecar replay returned ${replay.length} chunks`);
  const payloads = replay.map((event) => JSON.parse(Buffer.from(event.payload).toString('utf8')) as { type?: string });
  if (payloads.map((payload) => payload.type).join(',') !== 'run_started,message_delta,done')
    throw new Error(`unexpected worker replay: ${JSON.stringify(payloads)}`);
  console.log('in-process stream-writer authoritative smoke passed (not a forked provider worker)');
} finally {
  child.kill('SIGINT');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(() => resolve(), 5_000).unref();
  });
  cleanup();
}
