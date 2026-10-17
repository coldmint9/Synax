import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RustRuntimeSupervisor } from '../services/local-node/infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-runtime-outbox-maintenance-'));
const baseEnv = {
  SYNAX_RUNTIME_HISTORY_OUTBOX_MAINTENANCE_MS: '60000',
  SYNAX_RUNTIME_HISTORY_OUTBOX_MAINTENANCE_BATCH: '2',
  SYNAX_RUNTIME_HISTORY_OUTBOX_MAINTENANCE_SESSIONS: '64',
};

let supervisor: RustRuntimeSupervisor | undefined;
let client: RuntimeSidecarClient | undefined;

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const readJson = <T>(bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as T;

async function start(env: NodeJS.ProcessEnv = baseEnv): Promise<void> {
  supervisor = new RustRuntimeSupervisor({ dataRoot: root, env });
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
}

async function stop(): Promise<void> {
  client?.close();
  client = undefined;
  await supervisor?.stop();
  supervisor = undefined;
}

async function history<T>(sessionId: string, requestId: string, operation: string, payload: unknown = {}): Promise<T> {
  assert(client);
  return readJson<T>(await client.historyCommand({ sessionId, requestId, operation, payload }));
}

async function appendSession(sessionId: string, count: number, reconciliable = false): Promise<number> {
  assert(client);
  await client.seedUi(sessionId, json({ id: sessionId, projectId: 'smoke', status: 'queued', updatedAt: new Date().toISOString() }));
  const admitted = await client.admitRun({
    sessionId,
    requestId: `${sessionId}:admit`,
    bodyHash: `${sessionId}:body`,
    runId: `${sessionId}:run`,
    epoch: 1,
    revision: 0,
    run: { id: `${sessionId}:run`, sessionId, status: 'queued', startedAt: new Date().toISOString(), metadata: {} },
  });
  const activated = await client.activateRun({
    sessionId,
    requestId: `${sessionId}:activate`,
    epoch: admitted.epoch,
    revision: admitted.revision,
    run: { id: `${sessionId}:run`, sessionId, status: 'queued', startedAt: new Date().toISOString(), metadata: {} },
  });
  const response = await client.appendStream({
    sessionId,
    runId: `${sessionId}:run`,
    producerId: `${sessionId}:producer`,
    producerSequence: 1,
    epoch: activated.epoch,
    revision: activated.revision,
    events: Array.from({ length: count }, (_, index) => ({
      kind: 'message',
      payload: json({
        schema: 1,
        chunk: {
          type: 'message', sessionId, runId: `${sessionId}:run`,
          message: { id: `${sessionId}:message:${index}`, sessionId, runId: `${sessionId}:run`, role: 'assistant', content: `message-${index}` },
        },
        state: { status: 'running', activeRunId: `${sessionId}:run`, pendingResumeToken: null, blockedReason: null, updatedAt: new Date().toISOString() },
      }),
    })),
  });
  const match = /^stream:(\d+)-(\d+)$/.exec(response.request);
  assert(match, `invalid append receipt: ${response.request}`);
  return Number(match[2]);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('outbox maintenance condition timed out');
}

try {
  await start();

  // A direct control pass is bounded and drains only the durable ack watermark.
  const boundedSession = 'bounded';
  const boundedThrough = await appendSession(boundedSession, 7);
  assert.equal((await history<{ pending: number }>(boundedSession, 'bounded:before-ack', 'history_outbox_status')).pending, 7);
  await history(boundedSession, 'bounded:ack', 'ack_history_outbox', { through: boundedThrough });
  assert.equal((await history<{ pending: number }>(boundedSession, 'bounded:after-ack', 'history_outbox_status')).pending, 0);
  const boundedPasses: Array<{ removed: number; hasMoreAcked: boolean }> = [];
  for (;;) {
    const pass = await history<{ removed: number; hasMoreAcked: boolean }>(boundedSession, `bounded:maintain:${boundedPasses.length}`, 'maintain_history_outbox', { maxEntries: 2 });
    boundedPasses.push(pass);
    if (!pass.hasMoreAcked) break;
  }
  assert.deepEqual(boundedPasses.map(pass => pass.removed), [2, 2, 2, 1]);
  assert.equal((await history<{ removed: number; hasMoreAcked: boolean }>(boundedSession, 'bounded:repeat', 'maintain_history_outbox', { maxEntries: 2 })).removed, 0);

  // Reconcile can be retried after an ack or a connection loss without creating
  // duplicate logical entities in the indexed history view.
  const reconcileSession = 'duplicate-reconcile';
  await appendSession(reconcileSession, 1, true);
  assert.equal((await history<{ items: unknown[] }>(reconcileSession, 'reconcile:before', 'list_messages')).items.length, 0);
  await history(reconcileSession, 'reconcile:first', 'reconcile_stream');
  await history(reconcileSession, 'reconcile:duplicate', 'reconcile_stream');
  const reconciled = await history<{ items: Array<{ id: string }> }>(reconcileSession, 'reconcile:list', 'list_messages');
  assert.deepEqual(reconciled.items.map(item => item.id), [`${reconcileSession}:message:0`]);
  const reconciledMaintenance = await history<{ removed: number }>(reconcileSession, 'reconcile:maintain', 'maintain_history_outbox', { maxEntries: 2 });
  assert.equal(reconciledMaintenance.removed, 1);

  // The injected unknown ack is returned after the RocksDB commit. Restarting
  // the sidecar must retain the watermark and make the committed outbox item
  // safe for maintenance.
  const unknownAckSession = 'unknown-ack-restart';
  const unknownAckThrough = await appendSession(unknownAckSession, 2);
  await stop();
  await start({ ...baseEnv, SYNAX_RUNTIME_HOT_ACK_UNKNOWN: '1' });
  await assert.rejects(
    history(unknownAckSession, 'unknown-ack:commit', 'ack_history_outbox', { through: unknownAckThrough }),
    (error: unknown) => error instanceof RuntimeSidecarError && error.code === 'DURABILITY_UNKNOWN',
  );
  await stop();
  await start();
  assert.equal((await history<{ pending: number }>(unknownAckSession, 'unknown-ack:after-restart', 'history_outbox_status')).pending, 0);
  // The first interval tick runs immediately after startup, so the restart
  // itself proves that the committed watermark is enough to drain the old
  // entries without another foreground request.
  assert.deepEqual(
    await history<{ ackedThrough: number; removed: number; hasMoreAcked: boolean }>(unknownAckSession, 'unknown-ack:maintain-after-restart', 'maintain_history_outbox', { maxEntries: 1 }),
    { ackedThrough: unknownAckThrough, removed: 0, hasMoreAcked: false },
  );

  // A live sidecar drains acked entries without a foreground request. The
  // final explicit pass must therefore find no remaining work.
  await stop();
  await start({ ...baseEnv, SYNAX_RUNTIME_HISTORY_OUTBOX_MAINTENANCE_MS: '10' });
  const backgroundSession = 'background';
  const backgroundThrough = await appendSession(backgroundSession, 7);
  await history(backgroundSession, 'background:ack', 'ack_history_outbox', { through: backgroundThrough });
  await new Promise(resolve => setTimeout(resolve, 750));
  const backgroundPass = await history<{ removed: number; hasMoreAcked: boolean }>(backgroundSession, 'background:verify', 'maintain_history_outbox', { maxEntries: 2 });
  assert.deepEqual(backgroundPass, { ackedThrough: backgroundThrough, removed: 0, hasMoreAcked: false });

  console.log('runtime sidecar outbox maintenance smoke passed: bounded cleanup, duplicate reconcile, unknown ack restart recovery, and background drain.');
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
