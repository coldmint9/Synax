import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { RustRuntimeSupervisor } from './rust-sidecar.js';

const resources: Array<{ root: string; supervisor: RustRuntimeSupervisor }> = [];
function create(mode = 'ready', options: ConstructorParameters<typeof RustRuntimeSupervisor>[0] = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'synax-supervisor-unit-'));
  const fixture = path.join(root, 'child.cjs');
  writeFileSync(fixture, `
    process.stdin.resume();
    if (process.env.MODE === 'hang') process.on('SIGINT', () => {});
    else { process.on('SIGINT', () => process.exit(0)); process.stdin.on('end', () => process.exit(0)); }
    if (process.env.MODE !== 'hang') console.log('SYNAX_RUNTIME_READY:' + JSON.stringify({
      type: 'runtime_ready', protocol: process.env.MODE === 'bad' ? 'invalid' : 'synax.runtime.v2',
      pid: process.pid, port: 34567, socket: process.env.SYNAX_RUNTIME_SIDECAR_SOCKET, capabilities: ['append_receipts'],
    }));
    if (process.env.MODE === 'crash') setTimeout(() => process.exit(17), 60);
    setInterval(() => {}, 1000);
  `);
  const supervisor = new RustRuntimeSupervisor({ binaryPath: process.execPath, args: [fixture], dataRoot: root,
    env: { MODE: mode }, startTimeoutMs: 2000, stopTimeoutMs: 50, restartDelaysMs: [5, 10],
    probe: async () => {}, ...options });
  resources.push({ root, supervisor });
  return supervisor;
}
afterEach(async () => {
  for (const { root, supervisor } of resources.splice(0)) {
    await supervisor.stop(); rmSync(root, { recursive: true, force: true });
  }
});
it('kills and reaps a child that never reaches READY', async () => {
  const supervisor = create('hang', { startTimeoutMs: 80 });
  await expect(supervisor.start()).rejects.toThrow('startup timed out');
  expect(supervisor.process.exitCode !== null || supervisor.process.signalCode !== null).toBe(true);
  expect(supervisor.status).toBe('failed');
});
it('rejects incompatible READY and cleans up its process', async () => {
  const supervisor = create('bad');
  await expect(supervisor.start()).rejects.toThrow('incompatible READY');
  expect(supervisor.process.exitCode !== null || supervisor.process.signalCode !== null).toBe(true);
});
it('does not unlink an endpoint it never owned after a failed startup', async () => {
  const supervisor = create('bad');
  writeFileSync(supervisor.socketPath, 'another owner');
  try {
    await expect(supervisor.start()).rejects.toThrow('incompatible READY');
    await supervisor.stop();
    expect(readFileSync(supervisor.socketPath, 'utf8')).toBe('another owner');
  } finally { rmSync(supervisor.socketPath, { force: true }); }
});
it('cancels an in-progress health probe during shutdown', async () => {
  let entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  const supervisor = create('ready', { probe: async () => { entered(); await new Promise(() => {}); } });
  const starting = supervisor.start();
  const rejected = expect(starting).rejects.toThrow('cancelled');
  await probing; await supervisor.stop(); await rejected;
  expect(supervisor.status).toBe('stopped');
  expect(supervisor.process.exitCode !== null || supervisor.process.signalCode !== null).toBe(true);
});
it('cancels a scheduled restart and rejects readiness waiters on stop', async () => {
  const supervisor = create('ready', { restartDelaysMs: [100] });
  await supervisor.start();
  const child = supervisor.process;
  child.kill('SIGKILL'); await once(child, 'exit');
  expect(supervisor.status).toBe('backoff');
  const rejected = expect(supervisor.waitUntilReady()).rejects.toThrow('stopped');
  await supervisor.stop(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(supervisor.process).toBe(child);
  expect(supervisor.status).toBe('stopped');
  expect(process.env.SYNAX_RUNTIME_SIDECAR_TOKEN).not.toBe(supervisor.token);
});
it('bounds repeated crashes instead of restarting forever', async () => {
  const supervisor = create('ready');
  await supervisor.start();
  for (let count = 0; count < 3; count++) {
    const child = supervisor.process;
    child.kill('SIGKILL'); await once(child, 'exit');
    if (count < 2) await supervisor.waitUntilReady();
  }
  expect(supervisor.status).toBe('failed');
  expect(supervisor.generation).toBe(3);
  await expect(supervisor.waitUntilReady()).rejects.toThrow('exited');
});
