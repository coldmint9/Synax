import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-worker-process-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: RuntimeSidecarClient | undefined;
let worker: ChildProcess | undefined;
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const sessionId = 'forked-worker-session';
  const runId = 'forked-worker-run';
  const encoder = new TextEncoder();
  await client.seedUi(sessionId, encoder.encode(JSON.stringify({ id: sessionId, projectId: 'p', status: 'queued', updatedAt: new Date().toISOString() })));
  const admission = await client.admitRun({ sessionId, requestId: 'forked-admit', bodyHash: 'body', runId, epoch: 1, revision: 0 });
  await client.activateRun({ sessionId, requestId: 'forked-activate', epoch: admission.epoch, revision: admission.revision,
    run: { id: runId, sessionId, status: 'queued', startedAt: new Date().toISOString(), completedAt: null, metadata: {} } });
  const launcher = path.join(root, 'worker.mjs');
  const clientModule = pathToFileURL(path.resolve('services/local-node/modules/agent-runtime/sidecar/sidecar-client.ts')).href;
  await writeFile(launcher, `
    const { RuntimeSidecarClient } = await import(${JSON.stringify(clientModule)});
    const client = new RuntimeSidecarClient({ socketPath: process.env.WORKER_SOCKET, token: process.env.WORKER_TOKEN });
    const encoder = new TextEncoder();
    await client.appendStream({ sessionId: process.env.WORKER_SESSION, runId: process.env.WORKER_RUN, producerId: 'forked-node-worker', producerSequence: 1, epoch: 1, revision: 2, durability: 'group_commit', events: [
      { kind: 'step_started', payload: encoder.encode(JSON.stringify({ schema: 1, chunk: { type: 'step_started', sessionId: process.env.WORKER_SESSION, runId: process.env.WORKER_RUN, step: { id: 'step', sessionId: process.env.WORKER_SESSION, runId: process.env.WORKER_RUN, index: 1 } }, state: { status: 'running', activeRunId: process.env.WORKER_RUN, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() } })) },
      { kind: 'message_delta', payload: encoder.encode(JSON.stringify({ schema: 1, chunk: { type: 'message_delta', sessionId: process.env.WORKER_SESSION, runId: process.env.WORKER_RUN, stepId: 'step', delta: 'forked worker output' }, state: { status: 'running', activeRunId: process.env.WORKER_RUN, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() } })) },
    ]});
    client.close();
    process.send?.({ type: 'worker_done' });
  `);
  worker = fork(launcher, [], { env: { ...process.env, WORKER_SOCKET: supervisor.socketPath, WORKER_TOKEN: supervisor.token, WORKER_SESSION: sessionId, WORKER_RUN: runId }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--import', 'tsx/esm'] });
  const workerDone = new Promise<void>((resolve, reject) => {
    worker!.on('message', message => { if ((message as { type?: string }).type === 'worker_done') resolve(); });
    worker!.on('error', reject);
    worker!.on('exit', code => { if (code !== 0) reject(new Error(`forked worker exited with ${code}`)); });
  });
  await workerDone;
  const replay = await client.replay(sessionId, 0);
  assert.deepEqual(replay.events.map(event => event.kind), ['run_activated', 'step_started', 'message_delta']);
  const snapshot = await client.snapshot(sessionId);
  await client.finishRun({ sessionId, requestId: 'forked-finish', runId, status: 'completed', epoch: snapshot.epoch, revision: snapshot.revision,
    run: { id: runId, sessionId, status: 'completed', completedAt: new Date().toISOString(), metadata: {} } });
  console.log('Forked Node worker smoke passed: separate child process authenticated over Unix IPC and appended ordered Rust-authoritative stream events.');
} finally {
  client?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await once(worker, 'exit').catch(() => {}); }
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
