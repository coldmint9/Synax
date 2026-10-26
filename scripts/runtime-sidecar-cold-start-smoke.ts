import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'synax-cold-start-'));
let child: ChildProcess | undefined;
let seed: RustRuntimeSupervisor | undefined;
let client: RuntimeSidecarClient | undefined;
try {
  seed = new RustRuntimeSupervisor({ dataRoot: root });
  await seed.start();
  client = new RuntimeSidecarClient({ socketPath: seed.socketPath, token: seed.token });
  await client.seedUi('ars_healthy', Buffer.from(JSON.stringify({
    id: 'ars_healthy', projectId: 'fixture', profileId: 'synax', title: 'Healthy saved session',
    prompt: 'fixture', status: 'completed', activeRunId: null, sessionMetadata: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })));
  client.close(); client = undefined;
  await seed.stop(); seed = undefined;
  // A valid frame containing invalid JSON used to abort the entire root open.
  const brokenId = 'ars_corrupt';
  const shard = createHash('sha256').update(brokenId).digest('hex').slice(0, 2);
  const directory = path.join(root, 'runtime-sidecar/jsonl/sessions', shard, brokenId, 'events-v2/000000');
  await mkdir(directory, { recursive: true });
  const payload = Buffer.from('invalid-json');
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  await writeFile(path.join(directory, 'clse.000000'), Buffer.concat([size, payload]));

  child = spawn(process.execPath, ['--import', 'tsx/esm', 'services/local-node/entrypoints/http-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, OPENAI_API_KEY: 'fixture-not-used', DATA_ROOT: root, PORT: '0', NODE_ENV: 'test', SYNAX_DESKTOP_SIDECAR: '1', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API was blocked by cold history: ${output.slice(-2000)}`)), 15_000);
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited before READY: ${code}`)); });
    child!.once('error', error => { clearTimeout(timer); reject(error); });
    child!.stderr!.on('data', bytes => { output = (output + bytes.toString()).slice(-50_000); });
    let stdout = '';
    child!.stdout!.on('data', bytes => {
      stdout += bytes.toString(); output = (output + bytes.toString()).slice(-50_000);
      const match = /^SYNAX_DESKTOP_READY:(\d+)$/m.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const token = (await readFile(path.join(root, 'runtime-access-token'), 'utf8')).trim();
  const request = (route: string) => fetch(`http://127.0.0.1:${port}${route}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  });
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/agent-runtime/protocol')).status, 200);
  const snapshot = await request('/api/agent-runtime/sessions/ars_healthy/snapshot');
  assert.equal(snapshot.status, 200, await snapshot.clone().text());
  assert.equal((await snapshot.json() as { session: { id: string } }).session.id, 'ars_healthy');
  const detail = await request('/api/agent-runtime/sessions/ars_healthy');
  assert.equal(detail.status, 200, await detail.clone().text());
  const created = await fetch(`http://127.0.0.1:${port}/api/agent-runtime/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'fixture', profileId: 'explorer', backendId: 'native', prompt: 'New task', workDir: root }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json() as { session: { id: string } };
  const newSession = await request(`/api/agent-runtime/sessions/${createdBody.session.id}`);
  assert.equal(newSession.status, 200, await newSession.clone().text());
  const state = await newSession.json() as { session: { sessionMetadata?: { runtimeControl?: unknown } } };
  assert(!state.session.sessionMetadata?.runtimeControl, 'new sessions must not be marked as interrupted by background recovery');
  assert.equal((await request('/api/logs')).status, 200);
  console.log('Cold startup passed: API READY, health, protocol, logs, healthy session reads and new-session creation remain available with an unreadable historical session.');
} finally {
  client?.close();
  await seed?.stop();
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(resolve => {
      const timer = setTimeout(() => child?.kill('SIGKILL'), 8_000);
      child!.once('close', () => { clearTimeout(timer); resolve(); });
    });
    child.kill('SIGTERM'); await stopped;
  }
  await rm(root, { recursive: true, force: true });
}
