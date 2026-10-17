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
  const globalCommand = async (requestId: string, operation: string, payload: unknown) =>
    JSON.parse(new TextDecoder().decode(await client!.historyCommandGlobal({ sessionId: 'asset:project', requestId, operation, payload })));

  const first = await command('object-1', 'put_object', { kind: 'message', value: { role: 'user', text: 'hello' } });
  const second = await command('object-2', 'put_object', { kind: 'message', value: { role: 'assistant', text: 'world' }, refs: [first.objectId] });
  await command('run-1', 'put_object', { kind: 'runtime.run', value: { id: 'run-1', sessionId: 's', status: 'completed' } });
  await command('message-1', 'put_object', { kind: 'runtime.message', value: { id: 'message-1', sessionId: 's', role: 'user', content: 'hello' } });
  assert.equal((await command('runs-1', 'list_runs', {})).items[0].id, 'run-1');
  assert.equal((await command('messages-1', 'list_messages', {})).items[0].id, 'message-1');
  const head = await command('head-1', 'head_switch', { objectId: second.objectId, expectedRevision: 0 });
  assert.equal(head.revision, 1);
  await command('checkpoint-1', 'checkpoint', { objectId: second.objectId, pinId: 'checkpoint:1' });
  const page = await command('page-1', 'page', { objectId: second.objectId, limit: 8 });
  assert.deepEqual(page.items.map((item: { objectId: string }) => item.objectId), [second.objectId, first.objectId]);
  assert.equal((await command('verify-1', 'verify', {})).ok, true);
  assert.equal((await command('gc-1', 'gc', {})).deleted, 2, 'unreachable indexed objects are collected');

  const blobA = Buffer.from('asset-a').toString('hex');
  const blobB = Buffer.from('asset-b').toString('hex');
  await globalCommand('asset-chunk-0', 'put_blob_chunk', { blobId: 'asset-1', index: 0, total: 2, bytesHex: blobA });
  await globalCommand('asset-chunk-1', 'put_blob_chunk', { blobId: 'asset-1', index: 1, total: 2, bytesHex: blobB });
  const manifest = await globalCommand('asset-manifest', 'put_blob_manifest', { blobId: 'asset-1', total: 2, size: 14 });
  assert.equal(manifest.size, 14);
  assert.equal((await globalCommand('asset-read-manifest', 'get_blob_manifest', { blobId: 'asset-1' })).total, 2);
  assert.equal((await globalCommand('asset-read-chunk', 'get_blob_chunk', { blobId: 'asset-1', index: 1 })).bytesHex, blobB);

  // Simulate hot-store commit followed by a missing history commit. The Rust
  // reconcile command must rebuild canonical history from retained hot events.
  const hotSession = 'hot-reconcile-session';
  await client.seedUi(hotSession, new TextEncoder().encode(JSON.stringify({ id: hotSession, projectId: 'p', status: 'queued', updatedAt: new Date().toISOString() })));
  const admitted = await client.admitRun({ sessionId: hotSession, requestId: 'hot-admit', bodyHash: 'hot-body', runId: 'hot-run', epoch: 1, revision: 0, run: { id: 'hot-run', sessionId: hotSession, status: 'queued', startedAt: new Date().toISOString(), metadata: {} } });
  const activated = await client.activateRun({ sessionId: hotSession, requestId: 'hot-activate', epoch: admitted.epoch, revision: admitted.revision, run: { id: 'hot-run', sessionId: hotSession, status: 'queued', startedAt: new Date().toISOString(), metadata: {} } });
  await client.appendStream({ sessionId: hotSession, runId: 'hot-run', producerId: 'hot-producer', producerSequence: 1, epoch: activated.epoch, revision: activated.revision, events: [{
    kind: 'message',
    payload: new TextEncoder().encode(JSON.stringify({ schema: 1, chunk: { type: 'message', sessionId: hotSession, runId: 'hot-run', message: { id: 'hot-message', sessionId: hotSession, runId: 'hot-run', role: 'assistant', content: 'recovered from hot' } }, state: { status: 'running', activeRunId: 'hot-run', pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() } })),
  }] });
  const beforeReconcile = await client.historyCommand({ sessionId: hotSession, requestId: 'hot-before', operation: 'list_messages', payload: {} });
  assert.equal(JSON.parse(new TextDecoder().decode(beforeReconcile)).items.length, 0);
  await client.historyCommand({ sessionId: hotSession, requestId: 'hot-reconcile', operation: 'reconcile_stream', payload: {} });
  const afterReconcile = await client.historyCommand({ sessionId: hotSession, requestId: 'hot-after', operation: 'list_messages', payload: {} });
  assert.equal(JSON.parse(new TextDecoder().decode(afterReconcile)).items[0].id, 'hot-message');

  // Exercise concurrent writes over the real IPC connection, not a mocked
  // database: every append must retain the current head and publish once.
  assert.equal((await command('fresh-query', 'list_messages', {})).items.length, 0);
  await Promise.all(Array.from({ length: 32 }, (_, sequence) => command(
    `append-${sequence}`, 'append_entities', { objects: [{ kind: 'runtime.message', value: {
      id: `message-${sequence}`, sessionId: 's', sequence, content: `text-${sequence}`,
    } }] },
  )));
  const updatedPayload = { objects: [{ kind: 'runtime.message', value: {
    id: 'message-0', sessionId: 's', sequence: 0, content: 'updated',
  } }] };
  const appendedHead = await command('update-message', 'append_entities', updatedPayload);
  const listed = await command('fresh-query', 'list_messages', {});
  assert.equal(listed.items.length, 32);
  assert.equal(listed.items[0].content, 'updated');
  assert.deepEqual(listed.items.map((item: { sequence: number }) => item.sequence), Array.from({ length: 32 }, (_, index) => index));
  assert.deepEqual(await command('update-message', 'append_entities', updatedPayload), appendedHead);
  await assert.rejects(command('update-message', 'append_entities', { objects: [{
    kind: 'runtime.message', value: { id: 'message-0', sessionId: 's', content: 'conflict' },
  }] }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(command('stale-head', 'head_switch', { objectId: second.objectId, expectedRevision: 0 }),
    { code: 'REVISION_CONFLICT', expected: 0, actual: appendedHead.revision });

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
  assert.equal(persisted.objectId, appendedHead.objectId);
  assert.deepEqual(await command('update-message', 'append_entities', updatedPayload), appendedHead);
  assert.equal((await command('fresh-query', 'list_messages', {})).items.length, 32);
  assert.equal((await command('verify-after-restart', 'verify', {})).ok, true);
  console.log('Rust history smoke passed: atomic concurrent entity appends, durable receipts, fresh reads, latest reachable versions, CAS/head/pin/GC and restart recovery.');
} finally {
  client?.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
