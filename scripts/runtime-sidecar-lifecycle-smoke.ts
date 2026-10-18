import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import type { AgentRun, AgentRunStreamChunk } from '../services/local-node/modules/agent-runtime/contracts.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-lifecycle-'));
Object.assign(process.env, {
  DATA_ROOT: root, NODE_ENV: 'test', LOG_LEVEL: 'error',
  SYNAX_RUNTIME_SIDECAR_SUPERVISOR: '1', SYNAX_RUNTIME_SIDECAR_STREAM: 'authoritative',
});
const { startRustRuntimeSidecar, stopRustRuntimeSidecar } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const runtime = await startRustRuntimeSidecar();
assert(runtime);
const client = new RuntimeSidecarClient({ socketPath: runtime.socketPath, token: runtime.token });
try {
  const { RunCoordinator } = await import('../services/local-node/modules/agent-runtime/run-coordinator.js');
  const { activateAcceptedRun } = await import('../services/local-node/modules/agent-runtime/run-admission.js');
  const { agentRuntimeStore } = await import('../services/local-node/modules/agent-runtime/session-store.js');
  const { agentSessionRuntime } = await import('../services/local-node/modules/agent-runtime/session-runtime.js');
  const { businessStore } = await import('../services/local-node/infrastructure/persistence/business-store.js');
  await businessStore.refresh();
  const cleanedUp = new Set<string>();
  const coordinator = new RunCoordinator({
    async *execute(sessionId, _mode, input): AsyncGenerator<AgentRunStreamChunk> {
      const state = await client.snapshot(sessionId);
      assert.equal(state.activeRunId, input.acceptedRunId, 'Rust admission must precede execution');
      const activated = JSON.parse(new TextDecoder().decode(await client.uiSnapshot(sessionId)));
      assert.equal(activated.session.status, 'running');
      assert.equal(activated.run.id, input.acceptedRunId);
      assert.equal(activated.run.status, 'running');
      const journal = await client.replay(sessionId, 0);
      assert(journal.events.some((event) => event.kind === 'run_activated'), 'Rust activation event must precede the provider');
      const run = activateAcceptedRun(sessionId, input.acceptedRunId!, 'user', null);
      agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
      yield { type: 'run_started', run };
      yield { type: 'message_delta', runId: run.id, stepId: 'step', delta: 'controlled lifecycle output' };
      const status = input.message === 'turn 3' ? 'blocked' : input.message === 'turn 4' ? 'failed' : 'completed';
      const reason = status === 'blocked' ? 'controlled blocker' : status === 'failed' ? 'original provider failure' : null;
      const completed = agentRuntimeStore.updateRun(run.id, { status, completedAt: new Date().toISOString(), stopReason: reason });
      agentRuntimeStore.updateSession(sessionId, { status: status === 'failed' ? 'failed' : 'completed', activeRunId: null });
      yield status === 'failed' ? { type: 'run_failed', run: completed, error: reason! } : { type: 'run_completed', run: completed };
      yield { type: 'done', sessionId, runId: run.id };
      cleanedUp.add(run.id);
    },
    async interrupt() {},
  });
  const session = agentSessionRuntime.create({ projectId: 'lifecycle', profileId: 'planner', prompt: 'Exercise the execution lifecycle.', workDir: root });
  const runs: string[] = [];
  let previousRevision = 0;
  let previousCursor = 0;
  for (let turn = 1; turn <= 4; turn++) {
    const accepted = await coordinator.submitAsync(session.id, { message: `turn ${turn}` }, `request-${turn}`);
    runs.push(accepted.run.id);
    await coordinator.waitForIdle();
    const state = await client.snapshot(session.id);
    assert.equal(state.activeRunId, undefined);
    assert.equal(state.epoch, turn + 1);
    assert(state.revision > previousRevision, 'Rust revision must advance for every durable lifecycle transition');
    assert(state.cursor > previousCursor, 'Rust cursor must advance for every durable lifecycle transition');
    previousRevision = state.revision;
    previousCursor = state.cursor;
    const ui = JSON.parse(new TextDecoder().decode(await client.uiSnapshot(session.id)));
    assert.equal(ui.cursor, state.cursor); assert.equal(ui.session.status, turn === 4 ? 'failed' : 'completed');
    assert(cleanedUp.has(accepted.run.id), 'the fence must allow the generator to finish after its terminal UI update');
    assert.equal(ui.session.activeRunId, null); assert.equal(ui.run.id, accepted.run.id);
    assert.deepEqual(ui.liveChunks, []);
    const terminal = (await client.replay(session.id, 0)).events.filter((event) => event.kind === 'run_finished' && event.runId === accepted.run.id).at(-1);
    assert(terminal, 'Rust replay must contain a terminal run_finished event');
    assert.equal(terminal.kind, 'run_finished');
    const payload = JSON.parse(new TextDecoder().decode(terminal.payload));
    const finalRun = agentRuntimeStore.getRun(accepted.run.id);
    assert.equal(payload.chunk.run.completedAt, finalRun.completedAt);
    assert.equal(payload.chunk.run.currentStep, finalRun.currentStep);
    assert.equal(payload.chunk.run.metadata.executionLease.closed, true);
    assert.equal(payload.state.updatedAt, finalRun.completedAt);
    assert.deepEqual(payload.chunk.run, ui.run);
    if (turn === 3) { assert.equal(ui.run.status, 'blocked'); assert.equal(ui.session.blockedReason, 'controlled blocker'); }
    if (turn === 4) { assert.equal(ui.run.status, 'failed'); assert.equal(ui.run.stopReason, 'original provider failure'); }
    assert.equal(ui.session.completedAt, finalRun.completedAt);
  }
  const replay = await client.replay(session.id, 0);
  assert.deepEqual(replay.events.map(event => event.sequence), Array.from({ length: replay.events.length }, (_, i) => i + 1));
  assert.deepEqual([...new Set(replay.events.map(event => event.runId).filter(Boolean))], runs);
  const historyRuns = JSON.parse(new TextDecoder().decode(await client.historyCommand({
    sessionId: session.id,
    requestId: 'history-list-runs',
    operation: 'list_runs',
    payload: {},
  }))) as { items: Array<{ id: string }> };
  assert.deepEqual(historyRuns.items.map(item => item.id).sort(), [...runs].sort(), 'completed run documents must be queryable from Rust history');
  await assert.rejects(client.appendStream({ sessionId: session.id, runId: runs[0], producerId: 'late',
    producerSequence: 1, epoch: 1, revision: 1, events: [{ kind: 'late', payload: new Uint8Array() }] }),
    { code: 'STALE_EPOCH' });

  const { inputQueueRuntime } = await import('../services/local-node/modules/agent-runtime/input-queue-runtime.js');
  const queued = agentSessionRuntime.create({ projectId: 'lifecycle', profileId: 'planner', prompt: 'Deliver queued input.', workDir: root });
  const delivered: string[] = [];
  const draining = new RunCoordinator({
    async *execute(sessionId, _mode, input) {
      const run = activateAcceptedRun(sessionId, input.acceptedRunId!, 'queue-user', null);
      agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
      yield { type: 'run_started', run };
      delivered.push(input.message!);
      if (input.message === 'first') await inputQueueRuntime.enqueue(sessionId, { message: 'second' });
      const finished = agentRuntimeStore.updateRun(run.id, { status: 'completed', completedAt: new Date().toISOString() });
      agentRuntimeStore.updateSession(sessionId, { status: 'completed', activeRunId: null });
      yield { type: 'run_completed', run: finished };
      yield { type: 'done', sessionId, runId: run.id };
    },
    async interrupt() {},
  });
  await draining.submitAsync(queued.id, { message: 'first' }, 'queue-first');
  await draining.waitForIdle();
  assert.deepEqual(delivered, ['first', 'second'], 'normal completion must automatically dispatch queued input');
  assert.deepEqual(await inputQueueRuntime.list(queued.id), []);

  // Resume the same durable run more than once, including a Rust crash while
  // its Node executor remains alive. Each resume gets a fresh execution lease.
  const waiting = agentSessionRuntime.create({ projectId: 'lifecycle', profileId: 'planner', prompt: 'Resume checkpoints.', workDir: root });
  const generations: string[] = [];
  let passes = 0;
  const resumable = new RunCoordinator({
    async *execute(sessionId, mode, input) {
      const context = input.executionContext!;
      generations.push(context.epoch);
      await client.assertExecutionLease(context);
      const run = mode === 'resume'
        ? agentRuntimeStore.updateRun(context.runId, { status: 'running', completedAt: null, stopReason: null })
        : activateAcceptedRun(sessionId, context.runId, 'resume-user', null);
      agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
      yield { type: mode === 'resume' ? 'run_resumed' : 'run_started', run };
      if (++passes === 2) {
        const exited = once(runtime.process, 'exit');
        runtime.process.kill('SIGKILL');
        await exited;
        await client.assertExecutionLease(context);
      }
      const status = passes < 3 ? 'waiting_permission' : 'completed';
      agentRuntimeStore.updateRun(run.id, { status, completedAt: status === 'completed' ? new Date().toISOString() : null });
      agentRuntimeStore.updateSession(sessionId, { status, activeRunId: status === 'completed' ? null : run.id });
      yield { type: 'done', sessionId, runId: run.id };
    },
    async interrupt() {},
  });
  const admitted = await resumable.submitAsync(waiting.id, { message: 'start' }, 'resume-start');
  for (let pass = 0; pass < 3; pass++) {
    if (pass) resumable.resume(waiting.id);
    await resumable.waitForIdle();
    const ui = JSON.parse(Buffer.from(await client.uiSnapshot(waiting.id)).toString());
    assert.equal(ui.run.status, pass < 2 ? 'waiting_permission' : 'completed', ui.run.stopReason);
    assert.equal(ui.run.metadata.executionLease.closed, true);
    assert.equal(ui.run.id, admitted.run.id);
  }
  assert.equal(new Set(generations).size, 3);
  assert.equal(passes, 3);
  assert(runtime.generation >= 2);

  // Persist the two host-crash windows: a terminal UI before finish_run, and
  // a waiting checkpoint before the executor has closed its lease.
  const { recoverRuntime } = await import('../services/local-node/modules/agent-runtime/runtime-recovery.js');
  const { patchRuntime } = await import('../services/local-node/modules/agent-runtime/sidecar/runtime-repository.js');
  const recoveryCases = [];
  for (const status of ['completed', 'failed', 'waiting_permission'] as const) {
    const session = agentSessionRuntime.create({ projectId: 'lifecycle', profileId: 'planner', prompt: `Recover ${status}.`, workDir: root });
    await agentRuntimeStore.flushSession(session.id);
    const context = { sessionId: session.id, runId: `recover-${status}`, hostId: 'previous-host', epoch: `generation-${status}` };
    const run: AgentRun = { id: context.runId, sessionId: session.id, status: 'queued',
      startedAt: new Date().toISOString(), completedAt: null, currentStep: 1,
      triggerMessageId: null, model: null, stopReason: null, metadata: {} };
    const before = await client.snapshot(session.id);
    const admitted = await client.admitRun({ sessionId: session.id, requestId: `admit-${status}`, bodyHash: status, runId: run.id, run, epoch: before.epoch, revision: before.revision });
    await client.activateRun({ sessionId: session.id, run, epoch: admitted.epoch, revision: admitted.revision });
    await patchRuntime(session.id, 'execution_open', context);
    await patchRuntime(session.id, 'run_patch', { runId: run.id, patch: { status,
      completedAt: status === 'waiting_permission' ? null : new Date().toISOString(), stopReason: `original-${status}` } });
    await patchRuntime(session.id, 'session_patch', { patch: { status, activeRunId: status === 'waiting_permission' ? run.id : null } });
    recoveryCases.push({ status, context });
  }
  await recoverRuntime('replacement-host');
  for (const { status, context } of recoveryCases) {
    const ui = JSON.parse(Buffer.from(await client.uiSnapshot(context.sessionId)).toString());
    assert.equal(ui.run.status, status);
    assert.equal(ui.run.stopReason, `original-${status}`);
    assert.equal(ui.run.metadata.executionLease.closed, true);
    const fence = await client.snapshot(context.sessionId);
    assert.equal(fence.activeRunId, status === 'waiting_permission' ? context.runId : undefined);
    await assert.rejects(client.assertExecutionLease(context), { code: 'EXECUTION_SUPERSEDED' });
    if (status === 'waiting_permission') {
      const resumed = { ...context, hostId: 'replacement-host', epoch: 'fresh-generation' };
      await patchRuntime(context.sessionId, 'execution_open', resumed);
      await client.assertExecutionLease(resumed);
      await patchRuntime(context.sessionId, 'execution_close', resumed);
    }
  }
  console.log('Node coordinator → Rust lifecycle passed: activation, complete/blocked/failed cleanup, original errors, automatic queued input, repeated checkpoint resume, real Rust crash/reconnect, startup recovery during terminal/waiting handoff, and stale-owner rejection. Controlled driver; no external LLM.');
} finally {
  client.close();
  await stopRustRuntimeSidecar(runtime);
  await rm(root, { recursive: true, force: true });
}
