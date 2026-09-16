import { recordRuntimeStream, RuntimeStreamWriter } from '../runtime-stream-writer.js';
import type { AgentRunStreamChunk, ToolCallRecord } from '../contracts.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
function toolCall(sessionId: string, runId: string): ToolCallRecord {
  return { id: `tc-${runId}`, sessionId, runId, stepId: 'step-1', modelToolCallId: 'm', toolId: 'read-file',
    category: 'read', mutability: 'read', argsHash: 'h', inputSummary: 'read', inputRef: {}, outputSummary: null,
    outputRef: null, status: 'running', permissionDecisionId: null, startedAt: new Date().toISOString(),
    endedAt: null, error: null };
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

describe('journal batch commit', () => {
  it('keeps caller order and monotonic sequences inside one batch', () => {
    const { session, run } = sessionRun();
    const call = toolCall(session.id, run.id);
    const records = runtimeJournal.appendBatch(session.id, run.id, [
      { type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'a' },
      { type: 'tool_call', runId: run.id, stepId: 'step-1', toolCall: call },
      { type: 'tool_result', runId: run.id, stepId: 'step-1', toolCall: call },
    ]);
    expect(records.map(record => record.chunk.type)).toEqual(['message_delta', 'tool_call', 'tool_result']);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index].sequence).toBe(records[index - 1].sequence + 1);
    }
    const persisted = runtimeJournal.read(session.id, records[0].sequence - 1, 10);
    expect(persisted.map(record => record.sequence)).toEqual(records.map(record => record.sequence));
    expect(persisted.map(record => record.chunk.type)).toEqual(['message_delta', 'tool_call', 'tool_result']);
  });

  it('snapshots the projected session state on every record in the batch', () => {
    const { session, run } = sessionRun();
    agentRuntimeStore.updateSession(session.id, { status: 'waiting_permission', pendingResumeToken: 'resume-1', blockedReason: 'ask' });
    const records = runtimeJournal.appendBatch(session.id, run.id, [
      { type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'a' },
      { type: 'tool_result', runId: run.id, stepId: 'step-1', toolCall: toolCall(session.id, run.id) },
    ]);
    const expected = { status: 'waiting_permission', activeRunId: run.id, pendingResumeToken: 'resume-1', blockedReason: 'ask' };
    for (const record of records) expect(record.state).toMatchObject(expected);
    // Persisted state must equal the in-memory projection, not just be self-consistent.
    expect(runtimeJournal.read(session.id).every(record => record.state.status === 'waiting_permission')).toBe(true);
  });

  it('rolls the whole batch back without partial rows when a chunk cannot be serialized', () => {
    const { session, run } = sessionRun();
    const before = runtimeJournal.cursor(session.id);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => runtimeJournal.appendBatch(session.id, run.id, [
      { type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'ok' },
      { type: 'event', event: circular as never },
    ])).toThrow();
    expect(runtimeJournal.cursor(session.id)).toBe(before);
    expect(runtimeJournal.read(session.id)).toHaveLength(0);
  });

  it('wakes waiters only after the batch is committed', async () => {
    const { session, run } = sessionRun();
    const pump = runtimeJournal.observe(session.id);
    const pending = pump.next();
    const records = runtimeJournal.appendBatch(session.id, run.id, [
      { type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'a' },
      { type: 'tool_call', runId: run.id, stepId: 'step-1', toolCall: toolCall(session.id, run.id) },
    ]);
    expect((await pending).value).toEqual(records[0]);
    expect((await pump.next()).value).toEqual(records[1]);
    await pump.return(undefined);
  });

  it('is a no-op for an empty batch', () => {
    const { session, run } = sessionRun();
    expect(runtimeJournal.appendBatch(session.id, run.id, [])).toEqual([]);
    expect(runtimeJournal.cursor(session.id)).toBe(0);
  });
});

describe('stream writer batching', () => {
  it('coalesces a buffered delta with the event that ends it in one ordered batch', () => {
    const { session, run } = sessionRun();
    const writer = new RuntimeStreamWriter(session.id, run.id);
    const batch = vi.spyOn(runtimeJournal, 'appendBatch');
    try {
      writer.write({ type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'partial' });
      writer.write({ type: 'tool_call', runId: run.id, stepId: 'step-1', toolCall: toolCall(session.id, run.id) });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][2].map(chunk => chunk.type)).toEqual(['message_delta', 'tool_call']);
    } finally { batch.mockRestore(); }
    writer.finish();
    expect(runtimeJournal.read(session.id).map(record => record.chunk.type)).toEqual(['message_delta', 'tool_call']);
  });

  it('flushes pre-run buffered chunks together with the chunk that reveals the run id, in order', () => {
    const { session, run } = sessionRun();
    const user = agentRuntimeStore.appendMessage({ id: 'msg-pre', sessionId: session.id, runId: null, stepId: null,
      role: 'user', content: 'hello', createdAt: new Date().toISOString(), metadata: {} });
    // No run id yet: the message is buffered until run_started reveals it.
    const writer = new RuntimeStreamWriter(session.id);
    const batch = vi.spyOn(runtimeJournal, 'appendBatch');
    try {
      writer.write({ type: 'message', message: user });
      expect(runtimeJournal.cursor(session.id)).toBe(0);
      writer.write({ type: 'run_started', run });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][2].map(chunk => chunk.type)).toEqual(['message', 'run_started']);
    } finally { batch.mockRestore(); }
    const persisted = runtimeJournal.read(session.id);
    expect(persisted.map(record => record.chunk.type)).toEqual(['message', 'run_started']);
    expect(persisted.map(record => record.runId)).toEqual([run.id, run.id]);
    expect(persisted[1].state.activeRunId).toBe(run.id);
  });

  it('does not coalesce a lone chunk into a batch', () => {
    const { session, run } = sessionRun();
    const writer = new RuntimeStreamWriter(session.id, run.id);
    const append = vi.spyOn(runtimeJournal, 'append');
    const batch = vi.spyOn(runtimeJournal, 'appendBatch');
    try {
      writer.write({ type: 'tool_call', runId: run.id, stepId: 'step-1', toolCall: toolCall(session.id, run.id) });
      expect(append).toHaveBeenCalledTimes(1);
      // `append` delegates to appendBatch, so a single chunk must appear as a length-1 batch.
      expect(batch.mock.calls.every(([, , chunks]) => chunks.length === 1)).toBe(true);
    } finally { append.mockRestore(); batch.mockRestore(); }
  });

  it('flushes a timer-buffered delta through the commit path exactly once', () => {
    vi.useFakeTimers();
    try {
      const { session, run } = sessionRun();
      const writer = new RuntimeStreamWriter(session.id, run.id);
      writer.write({ type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'buffered' });
      expect(runtimeJournal.cursor(session.id)).toBe(0);
      vi.advanceTimersByTime(40);
      const persisted = runtimeJournal.read(session.id);
      expect(persisted.map(record => record.chunk.type)).toEqual(['message_delta']);
      expect((persisted[0].chunk as { delta: string }).delta).toBe('buffered');
      // Timer already fired; a redundant flush must not duplicate the record.
      writer.flush();
      expect(runtimeJournal.read(session.id)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('finish() flushes the buffered delta and preserves its order before the terminal record', () => {
    const { session, run } = sessionRun();
    const writer = new RuntimeStreamWriter(session.id, run.id);
    writer.write({ type: 'message_delta', runId: run.id, stepId: 'step-1', delta: 'answer' });
    agentRuntimeStore.updateRun(run.id, { status: 'completed', completedAt: new Date().toISOString() });
    agentRuntimeStore.updateSession(session.id, { status: 'completed', activeRunId: null, updatedAt: new Date().toISOString() });
    writer.finish();
    const persisted = runtimeJournal.read(session.id);
    expect(persisted.map(record => record.chunk.type)).toEqual(['message_delta']);
    expect((persisted[0].chunk as { delta: string }).delta).toBe('answer');
  });

  it('abandons buffered work once the writer is no longer current, without partial commits', () => {
    const { session, run } = sessionRun();
    const step = agentRuntimeStore.appendRunStep({ id: 'step-1', sessionId: session.id, runId: run.id, index: 1,
      status: 'running', model: null, startedAt: new Date().toISOString(), completedAt: null, finishReason: null, metadata: {} });
    let current = true;
    const writer = new RuntimeStreamWriter(session.id, run.id, () => current);
    writer.write({ type: 'message_delta', runId: run.id, stepId: step.id, delta: 'stale' });
    expect(runtimeJournal.cursor(session.id)).toBe(0);
    current = false;
    writer.write({ type: 'tool_call', runId: run.id, stepId: step.id, toolCall: toolCall(session.id, run.id) });
    expect(runtimeJournal.cursor(session.id)).toBe(0);
    // finish() on an interrupted run would materialize a partial assistant message from
    // persisted deltas; the abandoned buffer must leave nothing for it to rebuild from.
    agentRuntimeStore.updateRun(run.id, { status: 'interrupted', completedAt: new Date().toISOString() });
    writer.flush();
    writer.finish();
    expect(runtimeJournal.read(session.id)).toHaveLength(0);
    const partials = agentRuntimeStore.listMessages(session.id).filter(message => message.role === 'assistant');
    expect(partials).toHaveLength(0);
  });
});
