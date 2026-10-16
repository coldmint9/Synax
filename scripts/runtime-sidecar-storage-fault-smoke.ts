import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-storage-fault-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root, env: { SYNAX_RUNTIME_HOT_DISK_FULL: '1' } });
let client: RuntimeSidecarClient | undefined;
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  await assert.rejects(
    client.seedUi('disk-full-session', new TextEncoder().encode(JSON.stringify({ id: 'disk-full-session', projectId: 'p', status: 'queued', updatedAt: new Date().toISOString() }))),
    (error: unknown) => error instanceof RuntimeSidecarError && error.code === 'DISK_FULL',
  );
  await assert.rejects(client.uiSnapshot('disk-full-session'), { code: 'PROJECTION_MISSING' });
  assert.equal((await client.health()).ok, true);
  console.log('Injected storage fault smoke passed: DISK_FULL is stable, no projection is created, and health remains available. This is a fault injection, not a physical ENOSPC test.');
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
