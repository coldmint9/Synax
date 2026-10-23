import { beforeEach, describe, expect, it } from 'vitest';
import { ensureTestRuntime, restartTestRuntime } from '../../../../test-fixtures/rust-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { decode, runtimeClient } from '../sidecar/runtime-repository.js';
import { SubagentCompletionBroker, readSubagentControl } from '../subagent-control-broker.js';
import type { AgentSession } from '../contracts.js';
import { randomUUID } from 'node:crypto';

let parentId: string, childId: string;
function session(id: string, parentSessionId: string | null): AgentSession {
  return { id, projectId: 'broker-tests', parentSessionId, childSessionIds: [], nodeId: null, profileId: 'executor', status: 'running',
    title: null, prompt: 'test', contextSnapshotId: null, thinkingMode: 'standard', permissionRules: [], createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, resultSummary: null, blockedReason: null, skillIds: [], mcpServerIds: [],
    activeRunId: null, pendingResumeToken: null, sessionMetadata: null };
}
beforeEach(async () => {
  await ensureTestRuntime();
  parentId = `broker-parent-${randomUUID()}`; childId = `broker-child-${randomUUID()}`;
  store.createSession(session(parentId, null)); store.createSession(session(childId, parentId)); await store.flush();
});

describe('subagent mailbox through the real Rust repository', () => {
  it('serializes competing publishers through CAS and projects one newest summary', async () => {
    const first = new SubagentCompletionBroker(), second = new SubagentCompletionBroker();
    const event = { taskId: childId, parentSessionId: parentId, childSessionId: childId, status: 'running', joinMode: 'blocking' as const };
    await first.publish({ ...event, revision: 1, eventSeq: 1, summary: 'First' });
    const results = await Promise.allSettled([
      first.publish({ ...event, revision: 2, eventSeq: 2, summary: 'Second' }),
      second.publish({ ...event, revision: 3, eventSeq: 3, summary: 'Latest', joinMode: 'async' }),
    ]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    await store.hydrateSessionSummary(childId, true);
    expect(readSubagentControl(store.getSession(childId))).toMatchObject({ eventSeq: 3, summary: 'Latest', joinMode: 'async' });
    const page = decode<{ items: Array<{ id: string; content: string }> }>(await runtimeClient().historyCommand({ sessionId: parentId,
      requestId: randomUUID(), operation: 'list_messages', payload: { limit: 16 } }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe('Latest');
    await second.acknowledge(parentId, childId, 3);
    await store.hydrateSessionSummary(childId, true);
    expect(readSubagentControl(store.getSession(childId))?.consumedSeq).toBe(3);
  });

  it('preserves concurrent metadata keys and rehydrates a cold mailbox without loading parent history', async () => {
    const broker = new SubagentCompletionBroker();
    await broker.publish({ taskId: childId, parentSessionId: parentId, childSessionId: childId, status: 'paused', terminal: true,
      joinMode: 'blocking', revision: 1, summary: 'Paused safely.', epoch: '1' });
    store.updateSessionMetadata(childId, { unrelatedControl: { keep: true } });
    await store.flushSession(childId);
    store.reset();
    await restartTestRuntime();
    expect(await broker.recover(parentId, childId)).toMatchObject({ status: 'paused', epoch: '1' });
    expect(store.getSession(childId).sessionMetadata?.unrelatedControl).toEqual({ keep: true });
    expect(await broker.wait({ parentSessionId: parentId, childSessionIds: [childId] })).toMatchObject({ reason: 'terminal' });
    await broker.publish({ taskId: childId, parentSessionId: parentId, childSessionId: childId, status: 'running',
      joinMode: 'async', revision: 2, summary: 'Resumed independently.', epoch: '2' });
    expect(await broker.wait({ parentSessionId: parentId, childSessionIds: [childId] })).toMatchObject({ reason: 'released' });
  });
});
