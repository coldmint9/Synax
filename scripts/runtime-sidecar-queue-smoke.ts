import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import type { AgentRunStreamChunk } from '../services/local-node/modules/agent-runtime/contracts.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-rust-queue-'));
Object.assign(process.env, { DATA_ROOT: root, NODE_ENV: 'test', LOG_LEVEL: 'error', SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '1', SYNAX_RUNTIME_SIDECAR_STREAM: 'authoritative' });
const { startRustRuntimeSidecar, stopRustRuntimeSidecar } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const runtime = await startRustRuntimeSidecar(); assert(runtime);
const client = new RuntimeSidecarClient({ socketPath: runtime.socketPath, token: runtime.token });
const waitFor = async (fn: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!(await fn())) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};
let release: () => void = () => {};
try {
  const { RunCoordinator } = await import('../services/local-node/modules/agent-runtime/run-coordinator.js');
  const { activateAcceptedRun } = await import('../services/local-node/modules/agent-runtime/run-admission.js');
  const { agentRuntimeStore } = await import('../services/local-node/modules/agent-runtime/session-store.js');
  const { agentSessionRuntime } = await import('../services/local-node/modules/agent-runtime/session-runtime.js');
  const { inputQueueRuntime } = await import('../services/local-node/modules/agent-runtime/input-queue-runtime.js');
  const { inputQueueService } = await import('../services/local-node/modules/agent-runtime/input-queue-service.js');
  const { runtimeFacade } = await import('../services/local-node/modules/agent-runtime/sidecar/runtime-facade.js');
  const { agentRuntimeRoutes } = await import('../services/local-node/transport/http/agent-runtime.js');
  const { businessStore } = await import('../services/local-node/infrastructure/persistence/business-store.js');
  await businessStore.refresh();
  const plannerSessionInput = { projectId: 'queue-smoke', profileId: 'planner', prompt: 'Exercise the durable input queue.' };
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: tmpdir() });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed: string[] = [];
  const coordinator = new RunCoordinator({
    async *execute(sessionId, _mode, input): AsyncGenerator<AgentRunStreamChunk> {
      const run = activateAcceptedRun(sessionId, input.acceptedRunId!, 'message', null);
      agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
      const queueItem = (run.metadata.runtime as any)?.queueItem;
      if (queueItem) assert(!(await inputQueueRuntime.list(sessionId)).some(item => item.id === queueItem.id), 'Rust admission must consume the selected input before execution');
      observed.push(input.message ?? '');
      yield { type: 'run_started', run };
      if (observed.length === 1) await gate;
      const completed = agentRuntimeStore.updateRun(run.id, { status: 'completed', completedAt: new Date().toISOString() });
      agentRuntimeStore.updateSession(sessionId, { status: 'completed', activeRunId: null });
      yield { type: 'run_completed', run: completed }; yield { type: 'done', sessionId, runId: run.id };
    }, async interrupt() { release(); },
  });
  await coordinator.submitAsync(session.id, { message: 'first' }, 'first');
  await waitFor(() => observed.length === 1, 'first run');
  const firstResponse = await agentRuntimeRoutes.request(`/sessions/${session.id}/input-queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'second' }) });
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const firstQueue = (await firstResponse.json()) as { items: Array<{ id: string }> };
  assert.equal(firstQueue.items.length, 1);
  const two = await inputQueueRuntime.enqueue(session.id, { message: 'third' });
  assert.equal(two.length, 2);
  await inputQueueRuntime.move(session.id, two[1].id, { toIndex: 0 });
  assert.equal((await inputQueueRuntime.list(session.id))[0].message, 'third');
  assert.deepEqual(inputQueueService.list(session.id), []);
  assert.equal((await inputQueueRuntime.list(session.id)).length, 2);
  const old = runtime.process; const exited = once(old, 'exit'); old.kill('SIGKILL'); await exited; await runtime.waitUntilReady();
  assert.equal((await inputQueueRuntime.list(session.id)).length, 2);
  release(); await coordinator.waitForIdle();
  assert.deepEqual(observed, ['first', 'third', 'second']);
  assert.equal((await inputQueueRuntime.list(session.id)).length, 0);
  const replay = await client.replay(session.id, 0);
  assert.equal(replay.events.filter(event => event.kind === 'input_queue_changed').length, 5); // 2 enqueues, move, 2 atomic admissions
  const raw = agentRuntimeStore.getSession(session.id).sessionMetadata;
  assert.deepEqual(raw?.inputQueue ?? [], []); assert.equal(raw?.inputForceInjectId ?? null, null);

  const idle = agentSessionRuntime.create({ ...plannerSessionInput, workDir: tmpdir() });
  await runtimeFacade.ensureUiProjection(idle.id);
  for (let attempt = 0; ; attempt++) {
    const fence = await client.snapshot(idle.id);
    try {
      await client.admitRun({ sessionId: idle.id, requestId: 'delivery-run', runId: 'delivery', bodyHash: 'body', epoch: fence.epoch, revision: fence.revision });
      break;
    } catch (error) {
      if (attempt >= 7 || (error as { code?: string }).code !== 'REVISION_CONFLICT') throw error;
    }
  }
  const item = (await inputQueueRuntime.enqueue(idle.id, { message: 'steering' }))[0];
  await inputQueueRuntime.markForceInject(idle.id, item.id);
  assert.equal((await inputQueueRuntime.consumeForced(idle.id, 'delivery'))?.id, item.id);
  const deliveryOwner = runtime.process; const gone = once(deliveryOwner, 'exit'); deliveryOwner.kill('SIGKILL'); await gone; await runtime.waitUntilReady();
  assert.equal((await inputQueueRuntime.consumeForced(idle.id, 'delivery'))?.id, item.id, 'unacknowledged delivery must survive restart');
  await inputQueueRuntime.acknowledgeConsumption(idle.id, 'delivery', item.id);
  await inputQueueRuntime.acknowledgeConsumption(idle.id, 'delivery', item.id);
  assert.equal(await inputQueueRuntime.consumeForced(idle.id, 'delivery'), null);
  assert.equal((await inputQueueRuntime.list(idle.id)).length, 0);
  const parallel = agentSessionRuntime.create({ ...plannerSessionInput, workDir: tmpdir() });
  await runtimeFacade.ensureUiProjection(parallel.id);
  await Promise.all(Array.from({ length: 6 }, (_, index) => inputQueueRuntime.enqueue(parallel.id, { message: `parallel-${index}` })));
  const parallelQueue = await inputQueueRuntime.list(parallel.id);
  assert.equal(new Set(parallelQueue.map(item => item.id)).size, 6);
  assert.deepEqual(parallelQueue.map(item => item.message).sort(), Array.from({ length: 6 }, (_, index) => `parallel-${index}`));
  const failedDelete = await agentRuntimeRoutes.request(`/sessions/${parallel.id}/input-queue/missing`, { method: 'DELETE' });
  assert.equal(failedDelete.status, 400);
  const remove = await agentRuntimeRoutes.request(`/sessions/${parallel.id}/input-queue/${parallelQueue[0].id}`, { method: 'DELETE' });
  assert.equal(remove.status, 200); assert.equal((await inputQueueRuntime.list(parallel.id)).length, 5);
  assert.equal((await inputQueueRuntime.list(parallel.id)).length, 5);
  console.log('Rust input queue passed: HTTP enqueue/delete, concurrent revision retries, reordering, atomic admission consumption, restart, FIFO coordinator turns, and durable forced-delivery ACK; v2 delta storage. Controlled driver remains in memory; no model calls or execution restore.');
} finally { release(); client.close(); await stopRustRuntimeSidecar(runtime); await rm(root, { recursive: true, force: true }); }
