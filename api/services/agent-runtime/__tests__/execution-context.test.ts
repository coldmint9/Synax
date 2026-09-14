import { beforeEach, describe, expect, it } from 'vitest';
import { withinExecutionContext, type RuntimeExecutionContext } from '../../../lib/execution-context.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { getRawSqlite } from '../../../db/index.js';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
beforeEach(resetAgentRuntimeFixtures);

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
});
