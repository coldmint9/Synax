import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeSidecarClient } from '../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js';
import type { AgentRunStreamChunk } from '../services/local-node/modules/agent-runtime/contracts.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-lifecycle-'));
Object.assign(process.env, {
  DATA_ROOT: root, NODE_ENV: 'test', LOG_LEVEL: 'error',
  SYNAX_HISTORY_MODE: 'flat', SYNAX_TRANSCRIPT_STORAGE: 'legacy',
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
  const { plannerSessionInput, resetAgentRuntimeFixtures } = await import('../services/local-node/modules/agent-runtime/__tests__/agent-runtime-fixtures.js');
  resetAgentRuntimeFixtures();
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
      const status = input.message === 'turn 3' ? 'blocked' : 'completed';
      const completed = agentRuntimeStore.updateRun(run.id, { status, completedAt: new Date().toISOString(), stopReason: status === 'blocked' ? 'controlled blocker' : null });
      agentRuntimeStore.updateSession(sessionId, { status: 'completed', activeRunId: null });
      yield { type: 'run_completed', run: completed };
      yield { type: 'done', sessionId, runId: run.id };
    },
    async interrupt() {},
  });
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: tmpdir() });
  const runs: string[] = [];
  let previousRevision = 0;
  let previousCursor = 0;
  for (let turn = 1; turn <= 3; turn++) {
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
    assert.equal(ui.cursor, state.cursor); assert.equal(ui.session.status, 'completed');
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
  console.log('Node coordinator → Rust lifecycle passed: durable admission/activation before execution, three turns including a blocked terminal run, durable replay, epoch fencing. Driver is controlled; no external LLM was called.');
} finally {
  client.close();
  await stopRustRuntimeSidecar(runtime);
  await rm(root, { recursive: true, force: true });
}
