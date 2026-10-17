import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { assertDatabaseWriteAllowed, assertExecutionContextCurrent, runWithExecutionContext, setAuthoritativeExecutionFence, withinExecutionContext, type RuntimeExecutionContext } from '../../../infrastructure/runtime/execution-context.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { getRawSqlite } from '../../../infrastructure/database/index.js';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
beforeEach(resetAgentRuntimeFixtures);
afterEach(() => {
  setAuthoritativeExecutionFence(undefined);
  vi.unstubAllEnvs();
});

describe('execution generation fencing', () => {
  it('refuses late writes after a lease has changed, including direct SQL stores', async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const context: RuntimeExecutionContext = { sessionId: session.id, runId: 'fenced-run', epoch: 'old', hostId: 'test' };
    const run = agentRuntimeStore.appendRun({ id: context.runId, sessionId: session.id, status: 'running', startedAt: '', completedAt: null,
      triggerMessageId: null, currentStep: 0, stopReason: null, model: null, metadata: { executionLease: { ...context, closed: false } } });
    const source = (async function* () {
      agentRuntimeStore.updateSession(session.id, { title: 'Before restart' }); yield 1;
      getRawSqlite().prepare('UPDATE agent_runtime_sessions SET title = ? WHERE id = ?').run('Stale write', session.id);
      yield 2;
    })();
    const fenced = withinExecutionContext(context, source);
    expect((await fenced.next()).value).toBe(1);
    agentRuntimeStore.updateRun(run.id, { metadata: { executionLease: { ...context, epoch: 'new', closed: false } } });
    await expect(fenced.next()).rejects.toThrow(/superseded/);
    expect(agentRuntimeStore.getSession(session.id).title).toBe('Before restart');
  });

  it('uses the asynchronous authoritative fence without querying legacy lease or history-head tables', () => {
    vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
    const sqlite = getRawSqlite();
    const prepare = vi.spyOn(sqlite, 'prepare');
    const context: RuntimeExecutionContext = { sessionId: 'authoritative-session', runId: 'authoritative-run', epoch: 'rust-epoch', hostId: 'fixture-host' };

    runWithExecutionContext(context, () => assertDatabaseWriteAllowed(sqlite, ':memory:'));

    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining('agent_runtime_runs'));
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining('conversation_v3_heads'));
  });

  it('checks the Rust projection through an awaited fence before advancing an execution stream', async () => {
    vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
    const context: RuntimeExecutionContext = { sessionId: 's', runId: 'r', epoch: 'rust-epoch', hostId: 'fixture-host' };
    const fence = vi.fn(async (received: RuntimeExecutionContext) => {
      expect(received).toEqual(context);
    });
    setAuthoritativeExecutionFence(fence);

    await assertExecutionContextCurrent(context);

    expect(fence).toHaveBeenCalledOnce();
    expect(fence).toHaveBeenCalledWith(context);
  });

  it('places the authoritative fence before each async source advancement', async () => {
    vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
    const context: RuntimeExecutionContext = { sessionId: 's', runId: 'r', epoch: 'rust-epoch', hostId: 'fixture-host' };
    const fence = vi.fn(async () => undefined);
    setAuthoritativeExecutionFence(fence);
    const source = (async function* () { yield 'first'; yield 'second'; })();
    const guarded = withinExecutionContext(context, source);

    await expect(guarded.next()).resolves.toMatchObject({ value: 'first', done: false });
    await expect(guarded.next()).resolves.toMatchObject({ value: 'second', done: false });
    expect(fence).toHaveBeenCalledTimes(2);
  });

  it('propagates a superseded result from the authoritative fence', async () => {
    vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
    const context: RuntimeExecutionContext = { sessionId: 's', runId: 'r', epoch: 'rust-epoch', hostId: 'fixture-host' };
    setAuthoritativeExecutionFence(vi.fn(async () => {
      throw Object.assign(new Error('lease superseded'), { code: 'EXECUTION_SUPERSEDED' });
    }));

    await expect(assertExecutionContextCurrent(context)).rejects.toMatchObject({ code: 'EXECUTION_SUPERSEDED' });
  });

  it('keeps the SQLite lease guard for non-authoritative fixtures', () => {
    const sqlite = getRawSqlite();
    const context: RuntimeExecutionContext = { sessionId: 'fixture-session', runId: 'missing-run', epoch: 'old', hostId: 'fixture-host' };

    expect(() => runWithExecutionContext(context, () => assertDatabaseWriteAllowed(sqlite, ':memory:')))
      .toThrow(/superseded/);
  });
});
