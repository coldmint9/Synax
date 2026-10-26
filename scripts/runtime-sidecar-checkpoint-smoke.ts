import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-checkpoint-smoke-'));
const sessionId = 'checkpoint-session';
const shard = createHash('sha256').update(sessionId).digest('hex').slice(0, 2);
const directory = path.join(root, 'runtime-sidecar', 'jsonl', 'sessions', shard, sessionId);
const snapshots = ['runtime-checkpoint.bin', 'history/history-index.bin'];
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8'));
let supervisor: RustRuntimeSupervisor | undefined;
let client: RuntimeSidecarClient | undefined;
const start = async () => {
  supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
  return client;
};
const stop = async () => {
  client?.close();
  client = undefined;
  await supervisor?.stop();
  supervisor = undefined;
};

try {
  let runtime = await start();
  await runtime.seedUi(sessionId, json({ id: sessionId, projectId: 'p', status: 'queued', updatedAt: '2026-10-23T00:00:00Z' }));
  const control = { sessionId, requestId: 'stable-control', epoch: 1, revision: 0,
    operation: 'session_patch', payload: { patch: { title: 'Compressed checkpoint' } } };
  const controlReceipt = await runtime.controlCommand(control);
  const history = { sessionId, requestId: 'stable-history', operation: 'append_entities', payload: {
    objects: [{ kind: 'runtime.message', value: { id: 'm1', sessionId, role: 'user', content: '可恢复的正文 🦀\n'.repeat(5000), createdAt: '2026-10-23T00:00:00Z' } }],
  } };
  const historyReceipt = decode(await runtime.historyCommand(history));
  const expected = decode(await runtime.uiSnapshot(sessionId));
  await stop();
  for (const name of snapshots) {
    assert.equal((await readFile(path.join(directory, name)))[0], 2, `${name} must use compressed V2`);
  }
  for (const mode of ['compressed', 'corrupt'] as const) {
    if (mode === 'corrupt') {
      for (const name of snapshots) await writeFile(path.join(directory, name), 'torn checkpoint');
    }
    runtime = await start();
    assert.deepEqual(decode(await runtime.uiSnapshot(sessionId)), expected, mode);
    const retry = await runtime.controlCommand(control);
    assert.deepEqual(retry, controlReceipt, `${mode}: exact control receipt after restart`);
    assert.deepEqual(decode(await runtime.historyCommand(history)), historyReceipt, `${mode}: exact history receipt after restart`);
    const messages = decode(await runtime.historyCommand({ sessionId, requestId: `read-${mode}`, operation: 'list_messages', payload: {} }));
    assert.equal(messages.items.length, 1, `${mode}: retries must not duplicate history`);
    assert.equal(messages.items[0].id, 'm1');
    await stop();
  }
  console.log('Checkpoint smoke passed: compressed runtime/history snapshots, restart, exact retry receipts, corrupt-cache log recovery and no duplicate messages.');
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
