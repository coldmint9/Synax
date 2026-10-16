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
      const run = activateAcceptedRun(sessionId, input.acceptedRunId!, 'user', null);
      agentRuntimeStore.updateSession(sessionId, { status: 'running', activeRunId: run.id });
      yield { type: 'run_started', run };
      yield { type: 'message_delta', runId: run.id, stepId: 'step', delta: 'controlled lifecycle output' };
      const completed = agentRuntimeStore.updateRun(run.id, { status: 'completed', completedAt: new Date().toISOString() });
      agentRuntimeStore.updateSession(sessionId, { status: 'completed', activeRunId: null });
      yield { type: 'run_completed', run: completed };
      yield { type: 'done', sessionId, runId: run.id };
    },
    async interrupt() {},
  });
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: tmpdir() });
  const runs: string[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    const accepted = coordinator.submit(session.id, { message: `turn ${turn}` }, `request-${turn}`);
    runs.push(accepted.run.id);
    await coordinator.waitForIdle();
    const state = await client.snapshot(session.id);
    assert.equal(state.activeRunId, undefined);
    assert.equal(state.epoch, turn + 1);
    assert.equal(state.revision, turn * 2);
    assert.equal(state.cursor, turn * 4);
  }
  const replay = await client.replay(session.id, 0);
  assert.deepEqual(replay.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...new Set(replay.events.map(event => event.runId))], runs);
  await assert.rejects(client.appendStream({ sessionId: session.id, runId: runs[0], producerId: 'late',
    producerSequence: 1, epoch: 1, revision: 1, events: [{ kind: 'late', payload: new Uint8Array() }] }),
    { code: 'STALE_EPOCH' });
  console.log('Node coordinator → Rust lifecycle passed: admission before execution, two turns, durable replay, epoch fencing. Driver is controlled; no external LLM was called.');
} finally {
  client.close();
  await stopRustRuntimeSidecar(runtime);
  await rm(root, { recursive: true, force: true });
}
