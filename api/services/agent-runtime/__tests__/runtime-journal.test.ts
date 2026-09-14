import { recordRuntimeStream } from '../runtime-stream-writer.js';
import type { AgentRunStreamChunk } from '../contracts.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { runtimeJournal } from '../runtime-journal.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

beforeEach(resetAgentRuntimeFixtures);
function sessionRun() {
  const session = agentSessionRuntime.create(plannerSessionInput);
  const run = agentRuntimeStore.appendRun({ id: `run-${session.id}`, sessionId: session.id, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 0,
    stopReason: null, model: null, metadata: {} });
  agentRuntimeStore.updateSession(session.id, { activeRunId: run.id });
  return { session, run };
}

describe('durable runtime stream journal', () => {
  it('records an embedded host stream without launching a separate executor', async () => {
    const { session, run } = sessionRun();
    const source = (async function* (): AsyncGenerator<AgentRunStreamChunk> {
      yield { type: 'run_started', run };
      yield { type: 'message_delta', runId: run.id, stepId: 'embedded-step', delta: 'Embedded output' };
      const finished = agentRuntimeStore.updateRun(run.id, { status: 'completed' });
      yield { type: 'run_completed', run: finished };
      yield { type: 'done', sessionId: session.id, runId: run.id };
    })();
    const observed = [];
    for await (const chunk of recordRuntimeStream(session.id, source)) observed.push(chunk);
    expect(observed).toHaveLength(4);
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(1);
    expect(runtimeJournal.read(session.id).some(record => record.chunk.type === 'message_delta')).toBe(true);
  });

  it('keeps monotonic cursors across Session upserts and isolates streams by session', () => {
    const a = sessionRun(); const b = sessionRun();
    const first = runtimeJournal.append(a.session.id, a.run.id, { type: 'run_started', run: a.run });
    agentRuntimeStore.updateSession(a.session.id, { title: 'Updated' });
    runtimeJournal.append(b.session.id, b.run.id, { type: 'run_started', run: b.run });
    const second = runtimeJournal.append(a.session.id, a.run.id, { type: 'done', sessionId: a.session.id, runId: a.run.id });
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(runtimeJournal.read(a.session.id, first.sequence).map(record => record.sequence)).toEqual([second.sequence]);
  });

  it('does not lose an event between taking a cursor and attaching an observer', async () => {
    const { session, run } = sessionRun();
    const cursor = runtimeJournal.cursor(session.id);
    const expected = runtimeJournal.append(session.id, run.id, { type: 'run_started', run });
    const controller = new AbortController();
    const stream = runtimeJournal.observe(session.id, cursor, controller.signal);
    expect((await stream.next()).value).toEqual(expected);
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it('rejects writing an event under another session identity', () => {
    const a = sessionRun(); const b = sessionRun();
    expect(() => runtimeJournal.append(b.session.id, a.run.id, { type: 'run_started', run: a.run })).toThrow(/session/i);
  });
});
