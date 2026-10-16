import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'synax-physical-enospc-'));
const image = path.join(root, 'volume.sparseimage');
let device: string | undefined;
let mount: string | undefined;
let supervisor: RustRuntimeSupervisor | undefined;
let client: RuntimeSidecarClient | undefined;
try {
  await run('hdiutil', ['create', '-size', '256m', '-fs', 'APFS', '-volname', 'SYNAX_ENOSPC', '-type', 'SPARSE', image]);
  const attached = await run('hdiutil', ['attach', image, '-nobrowse', '-plist']);
  const plistPath = path.join(root, 'attach.plist');
  await writeFile(plistPath, attached.stdout);
  const plist = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', plistPath])).stdout) as { 'system-entities': Array<{ 'dev-entry'?: string; 'mount-point'?: string }> };
  const entity = plist['system-entities'].find(item => item['mount-point']);
  mount = entity?.['mount-point'];
  device = entity?.['dev-entry'];
  if (!mount || !device) throw new Error('Could not locate the mounted ENOSPC volume.');

  supervisor = new RustRuntimeSupervisor({ dataRoot: mount });
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const filler = path.join(mount, 'fill.bin');
  const block = Buffer.alloc(1024 * 1024, 0x5a);
  const handle = await import('node:fs/promises').then(fs => fs.open(filler, 'w'));
  let filled = 0;
  try {
    for (;;) { await handle.write(block); filled += block.length; }
  } catch { /* expected once the APFS sparse volume is full */ }
  await handle.close();
  assert(filled > 100 * 1024 * 1024, `volume filled only ${filled} bytes`);

  const largeSession = { id: 'physical-enospc-session', projectId: 'p', status: 'queued', updatedAt: new Date().toISOString(), sessionMetadata: { filler: 'x'.repeat(700 * 1024) } };
  await assert.rejects(client.seedUi(largeSession.id, new TextEncoder().encode(JSON.stringify(largeSession))), (error: unknown) =>
    error instanceof RuntimeSidecarError && ['DISK_FULL', 'STORAGE_UNAVAILABLE', 'DURABILITY_UNKNOWN'].includes(error.code));
  assert.equal((await client.health()).ok, true);
  console.log(`Physical ENOSPC smoke passed: filled ${(filled / 1024 / 1024).toFixed(1)} MiB; Rust returned a stable storage failure while health stayed available.`);
} finally {
  client?.close();
  await supervisor?.stop().catch(() => {});
  if (device) await run('hdiutil', ['detach', device]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
