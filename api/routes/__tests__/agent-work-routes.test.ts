import { workStore } from '../../services/agent-runtime/work-store.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentSessionRuntime } from '../../services/agent-runtime/session-runtime.js';
import { agentRuntimeStore as store } from '../../services/agent-runtime/session-store.js';
import { workRuntime } from '../../services/agent-runtime/work-runtime.js';
import { ensureSynaxAgentRegistered } from '../../services/agent-runtime/synax/index.js';
import { resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { startAuxUsage, finishAuxUsage } from '../../services/agent-runtime/usage-projection.js';

beforeEach(() => { resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });
describe('work-aware session API', () => {
  it('preserves historical plan and goal on mode switch without applying goal acceptance in chat', async () => {
    const session = agentSessionRuntime.create({ projectId: 'fixture', profileId: 'synax', prompt: 'Deliver verified change', sessionMetadata: { mode: 'goal' } });
    const plan = { title: 'Change', objective: 'Deliver verified change', status: 'approved', revision: 1, acceptanceCriteria: ['Behavior checked'], steps: [] };
    store.updateSessionMetadata(session.id, { plan, goal: { objective: plan.objective, status: 'executing' } });
    store.updateSession(session.id, { status: 'interrupted', activeRunId: null });
    const response = await agentRuntimeRoutes.request(`http://localhost/sessions/${session.id}/mode`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'chat' }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.session.sessionMetadata).toMatchObject({ mode: 'chat', plan, goal: { status: 'executing' } });
    const now = new Date().toISOString();
    const run = store.appendRun({ id: 'run', sessionId: session.id, status: 'running', startedAt: now, completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    store.updateSession(session.id, { status: 'running', activeRunId: run.id });
    workRuntime.attach(session.id, run);
    store.appendRunStep({ id: 'step', sessionId: session.id, runId: run.id, index: 1, status: 'running', startedAt: now, completedAt: null, model: null, finishReason: null, metadata: {} });
    await expect(workRuntime.complete({ sessionId: session.id, runId: run.id, stepId: 'step', toolCallId: '', toolId: 'runtime.final', category: 'task', mutability: 'task', args: {} }, 'Done', [])).resolves.toMatchObject({ displaySummary: 'Done' });
    expect(store.getSession(session.id).status).toBe('completed');
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({ status: 'executing' });
  });
  it('reopens completed Chat work only when the user explicitly selects a different workflow', async () => {
    const session = agentSessionRuntime.create({ projectId: 'fixture', profileId: 'synax', prompt: 'Discuss a change', sessionMetadata: { mode: 'chat' } });
    const work = workStore.create(session.id, session.prompt);
    work.status = 'completed'; work.result = 'Earlier chat answer';
    work.checkpoint = { throughStepId: 'retained-step', summary: 'Retained context', createdAt: new Date().toISOString() };
    workStore.save(work);
    store.updateSession(session.id, { status: 'completed', activeRunId: null });
    const switchTo = (mode: string) => agentRuntimeRoutes.request(`http://localhost/sessions/${session.id}/mode`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
    });
    expect((await switchTo('chat')).status).toBe(200);
    expect(workStore.current(session.id)?.status).toBe('completed');
    expect((await switchTo('goal')).status).toBe(200);
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', result: null, checkpoint: { summary: 'Retained context' } });
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({ status: 'planning' });
    expect(store.getSession(session.id).activeRunId).toBeNull();
    expect(store.listRuns(session.id)).toHaveLength(0);
  });
  it('counts auxiliary calls once and exposes separate context/usage fields', async () => {
    const session = agentSessionRuntime.create({ projectId: 'fixture', profileId: 'synax', prompt: 'Question' });
    const id = startAuxUsage(session.id, 'session-title');
    finishAuxUsage(id, { inputTokens: 100, outputTokens: 10 });
    finishAuxUsage(id, { inputTokens: 100, outputTokens: 10 });
    const response = await agentRuntimeRoutes.request(`http://localhost/sessions/${session.id}/stats`);
    expect(response.status).toBe(200);
    const stats = await response.json() as any;
    expect(stats.usage.self.total).toBe(110);
    expect(stats.coverage.self).toMatchObject({ requests: 1, recorded: 1, missing: 0 });
    expect(stats.context.inputTokens).toBeNull();
    expect(stats.usage.tree).toEqual(stats.usage.self);
  });
});
