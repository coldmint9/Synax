import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-history-'));
const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
let client: RuntimeSidecarClient | undefined;
try {
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const command = async (requestId: string, operation: string, payload: unknown) =>
    JSON.parse(new TextDecoder().decode(await client!.historyCommand({ sessionId: 's', requestId, operation, payload })));

  const first = await command('object-1', 'put_object', { kind: 'message', value: { role: 'user', text: 'hello' } });
  const second = await command('object-2', 'put_object', { kind: 'message', value: { role: 'assistant', text: 'world' }, refs: [first.objectId] });
  const head = await command('head-1', 'head_switch', { objectId: second.objectId, expectedRevision: 0 });
  assert.equal(head.revision, 1);
  await command('checkpoint-1', 'checkpoint', { objectId: second.objectId, pinId: 'checkpoint:1' });
  const page = await command('page-1', 'page', { objectId: second.objectId, limit: 8 });
  assert.deepEqual(page.items.map((item: { objectId: string }) => item.objectId), [second.objectId, first.objectId]);
  assert.equal((await command('verify-1', 'verify', {})).ok, true);
  assert.equal((await command('gc-1', 'gc', {})).deleted, 0);

  client.close(); client = undefined;
  const generation = supervisor.generation;
  supervisor.process.kill('SIGKILL');
  const deadline = Date.now() + 7000;
  while (supervisor.generation <= generation) {
    if (Date.now() >= deadline) throw new Error('Rust history smoke restart timed out.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  const persisted = await command('head-after-restart', 'head_read', {});
  assert.equal(persisted.objectId, second.objectId);
  assert.equal((await command('verify-after-restart', 'verify', {})).ok, true);
  console.log('Rust history smoke passed: immutable CAS objects, head switch, checkpoint pin, graph page, verify, GC and restart recovery.');
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
