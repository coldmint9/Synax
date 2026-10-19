/** Real protobuf IPC + Rust filesystem/watcher smoke. Uses only a temporary root. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-index-smoke-'));
const root = path.join(temporary, 'workspace');
await fs.mkdir(path.join(root, 'generated'), { recursive: true });
await fs.mkdir(path.join(root, 'src'));
await fs.mkdir(path.join(root, 'wide'));
await fs.writeFile(path.join(root, '.gitignore'), 'generated/\n');
await fs.writeFile(path.join(root, 'generated', 'hidden'), 'generated');
await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export {};');
await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(root, 'wide', `${String(i).padStart(3, '0')}.txt`), 'x')));
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\synax-index-${randomUUID()}` : path.join(temporary, 'index.sock');
const token = randomUUID();
const binary = process.env.SYNAX_RUNTIME_SIDECAR_BIN ?? path.resolve('runtime-sidecar/target/debug', process.platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar');
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
  SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath, SYNAX_RUNTIME_SIDECAR_TOKEN: token,
  SYNAX_RUNTIME_SIDECAR_PORT: '0', SYNAX_RUNTIME_PROVIDER_PORT: '0', SYNAX_RUNTIME_PARENT_WATCH: '1',
  SYNAX_RUNTIME_HOT_PATH: path.join(temporary, 'hot'), SYNAX_RUNTIME_HISTORY_PATH: path.join(temporary, 'history'),
} });
const client = new RuntimeSidecarClient({ socketPath, token, retryTimeoutMs: 5000 });
async function query(operation: 'list' | 'register' | 'status', extra: Record<string, unknown> = {}) {
  const bytes = await client.workspaceIndexCommand(operation, { hostPath: root, ...extra });
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
try {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('sidecar startup timed out')), 15000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`sidecar exited: ${code}`)); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('SYNAX_RUNTIME_READY:')) { clearTimeout(timer); resolve(); }
    });
  });
  assert.ok((await client.connect()).capabilities.includes('workspace_index'));
  await query('register');
  const started = Date.now();
  while ((await query('status')).indexing) {
    assert.ok(Date.now() - started < 5000);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const status = await query('status');
  assert.ok(status.cachedDirectories >= 2);
  assert.ok(status.deferredDirectories >= 1);
  assert.ok(!(await query('list')).entries.some((item: { name: string }) => item.name === 'generated'));
  const names: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await query('list', { path: 'wide', limit: 100, cursor });
    assert.ok(page.entries.length <= 100);
    names.push(...page.entries.map((item: { name: string }) => item.name));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(names.length, 205); assert.equal(new Set(names).size, 205);
  const before = (await query('status')).revision;
  await fs.rename(path.join(root, 'src', 'app.ts'), path.join(root, 'src', 'renamed.ts'));
  const changedAt = Date.now();
  while ((await query('status')).revision === before) {
    assert.ok(Date.now() - changedAt < 5000, 'watcher failed to report rename');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok((await query('list', { path: 'src' })).entries.some((item: { name: string }) => item.name === 'renamed.ts'));
  await assert.rejects(query('list', { path: '../' }), { code: 'INVALID_PATH' });
  const [, health] = await Promise.all([query('list', { path: 'wide' }), client.health()]);
  assert.equal(health.ok, true);
  console.log('PASS: Rust registration, eager/ignored/lazy indexing, 100-item pagination, native watcher, path boundary and concurrent health over private IPC.');
} finally {
  client.close();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const fallback = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited.catch(() => undefined); clearTimeout(fallback);
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
