import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-recovery-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: path.join(root, 'recover'),
  env: { SYNAX_RUNTIME_HOT_ABORT_APPEND_AFTER_COMMIT: '1' } });
let client: RuntimeSidecarClient | undefined;
let parent: ChildProcess | undefined;
let parentChild: { pid: number; socket: string } | undefined;
const orphanBinary = path.join(root, 'parent-sidecar');
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  await supervisor.start();
  const original = { token: supervisor.token, socket: supervisor.socketPath, pid: supervisor.process.pid };
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token, requestTimeoutMs: 1000, retryTimeoutMs: 10_000 });
  await client.seedUi('s', new TextEncoder().encode(JSON.stringify({ id: 's', projectId: 'p', status: 'queued', updatedAt: new Date().toISOString() })));
  await client.admitRun({ sessionId: 's', requestId: 'start', bodyHash: 'body', runId: 'r', epoch: 1, revision: 0 });
  const input = { sessionId: 's', runId: 'r', producerId: 'worker', producerSequence: 1, epoch: 1, revision: 1,
    durability: 'group_commit' as const, events: [{ kind: 'step_started', payload: new TextEncoder().encode(JSON.stringify({ schema: 1, chunk: { type: 'step_started', step: { id: 'step', sessionId: 's', runId: 'r', index: 1 } }, state: { status: 'running', activeRunId: 'r', blockedReason: null, pendingResumeToken: null, updatedAt: new Date().toISOString() } })) }] };
  // The first append aborts the real Rust process after its WAL barrier and before replying.
  const receipt = await client.appendStream(input);
  assert.equal(receipt.request, 'stream:1-1');
  assert(supervisor.generation >= 2);
  assert.notEqual(supervisor.process.pid, original.pid);
  assert.equal(supervisor.token, original.token);
  assert.equal(supervisor.socketPath, original.socket);
  assert.equal((await client.snapshot('s')).cursor, 1);
  const ui = JSON.parse(new TextDecoder().decode(await client.uiSnapshot('s')));
  assert.equal(ui.cursor, 1); assert.equal(ui.liveChunks[0].step.id, 'step');
  assert.equal((await client.replay('s', 0)).events.length, 1);
  await assert.rejects(client.appendStream({ ...input, events: [{ kind: 'delta', payload: new TextEncoder().encode('different content') }] }), { code: 'REQUEST_CONFLICT' });
  await client.finishRun({ sessionId: 's', requestId: 'finish', runId: 'r', status: 'completed', epoch: 1, revision: 1 });
  await client.appendStream(input); // Even a late duplicate after completion cannot reopen the run.
  assert.equal((await client.snapshot('s')).epoch, 2);
  assert.equal((await client.snapshot('s')).activeRunId, undefined);
  assert.equal((await client.health()).ok, true);
  client.close(); await supervisor.stop();
  assert.equal(existsSync(supervisor.socketPath), false);

  // An abruptly killed Node owner must not leave the RocksDB process or its socket alive.
  await copyFile(supervisor.binaryPath, orphanBinary); await chmod(orphanBinary, 0o755);
  const launcher = path.join(root, 'parent.mjs');
  const moduleUrl = pathToFileURL(path.resolve('services/local-node/infrastructure/runtime/rust-sidecar.ts')).href;
  await writeFile(launcher, `
    const { RustRuntimeSupervisor } = await import(${JSON.stringify(moduleUrl)});
    const supervisor = new RustRuntimeSupervisor({ binaryPath: ${JSON.stringify(orphanBinary)}, dataRoot: ${JSON.stringify(path.join(root, 'parent-data'))} });
    await supervisor.start();
    console.log('PARENT_READY:' + JSON.stringify({ pid: supervisor.process.pid, socket: supervisor.socketPath }));
    setInterval(() => {}, 1000);
  `);
  parent = spawn(process.execPath, ['--import', 'tsx/esm', launcher], { env: { ...process.env, LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
  parentChild = await new Promise<{ pid: number; socket: string }>((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`parent startup timed out: ${errors}`)), 10_000);
    parent!.stderr!.on('data', chunk => { errors += chunk; });
    parent!.stdout!.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(line => line.startsWith('PARENT_READY:'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('PARENT_READY:'.length))); }
    });
    parent!.once('error', error => { clearTimeout(timer); reject(error); });
    parent!.once('exit', code => { clearTimeout(timer); reject(new Error(`parent exited ${code}: ${errors}`)); });
  });
  const gone = once(parent, 'exit'); parent.kill('SIGKILL'); await gone;
  await waitFor(() => {
    try { process.kill(parentChild!.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }, 'Rust process survived the death of its Node owner');
  assert.equal(existsSync(parentChild.socket), false);
  console.log('Recovery passed: real post-commit abort → supervisor restart → identical retry → exactly one event; conflict rejection, completion fence, and Node-owner death cleanup verified.');
} finally {
  client?.close(); await supervisor.stop();
  if (parent && parent.exitCode === null && parent.signalCode === null) { const gone = once(parent, 'exit'); parent.kill('SIGKILL'); await gone; }
  if (parentChild) {
    try {
      const command = execFileSync('ps', ['-p', String(parentChild.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (command === orphanBinary) process.kill(parentChild.pid, 'SIGKILL');
    } catch { /* already reaped */ }
  }
  await rm(root, { recursive: true, force: true });
}
