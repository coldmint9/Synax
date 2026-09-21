import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { toolRegistry } from '../tool-registry.js';
import { workRuntime } from '../work-runtime.js';
import { workStore } from '../work-store.js';
import { goalStopReason } from '../control-runtime.js';
import { TaskStore } from '../tools/task-tools.js';
import { buildLoopStepNote } from '../loop-prompt.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resolveSessionCapabilities } from '../session-capabilities.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

beforeEach(() => { resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });
function session(mode: 'chat' | 'plan' | 'goal') {
  return agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'synax', prompt: 'Bounded request', sessionMetadata: { mode } });
}
function active(mode: 'chat' | 'plan' | 'goal') {
  const s = session(mode);
  const now = new Date().toISOString();
  const run = store.appendRun({ id: `run-${s.id}`, sessionId: s.id, status: 'running', startedAt: now, completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
  store.updateSession(s.id, { status: 'running', activeRunId: run.id });
  workRuntime.attach(s.id, run);
  store.appendRunStep({ id: `step-${s.id}`, sessionId: s.id, runId: run.id, index: 1, status: 'running', startedAt: now, completedAt: null, model: null, finishReason: null, metadata: {} });
  return { s, input: { sessionId: s.id, runId: run.id, stepId: `step-${s.id}`, toolCallId: '', toolId: 'runtime.final', category: 'task' as const, mutability: 'task' as const, args: {} } };
}

describe('workflow boundaries', () => {
  it.each(['chat', 'plan'] as const)('%s does not mount goal controls or receipts, including capability listings', async mode => {
    const s = session(mode);
    for (const includeGated of [false, true]) {
      const ids = toolRegistry.listForSession(s.id, { includeGated }).map(t => t.id);
      expect(ids).not.toContain('work.checkpoint');
      expect(ids).not.toContain('goal.finish');
      expect(ids).not.toContain('verification.run');
      expect(ids).toContain('context.read');
      expect(ids).toContain('human.ask');
      expect(ids).toContain('task.update');
    }
    expect(resolveSessionCapabilities(s.id).tools.available.map(t => t.id)).not.toContain('verification.run');
    for (const id of ['work.checkpoint', 'goal.finish', 'verification.run']) {
      const result = await toolRegistry.execute(s.id, id, {});
      expect(result.record.error).toMatch(/goal mode/i);
    }
  });
  it('chat does not mount planning controls without a deferred plan', () => {
    const s = session('chat');
    expect(toolRegistry.listForSession(s.id).map(t => t.id)).not.toContain('plan.propose');
    expect(toolRegistry.listForSession(s.id).map(t => t.id)).not.toContain('plan.execute');
    store.updateSessionMetadata(s.id, { plan: { status: 'saved' } });
    const ids = toolRegistry.listForSession(s.id).map(t => t.id);
    expect(ids).toContain('plan.execute');
    expect(ids).toContain('bash');
    expect(ids).toContain('file.write');
  });
  it('plan mounts proposal controls and read tools, not workspace execution', () => {
    const s = session('plan');
    const ids = toolRegistry.listForSession(s.id, { includeGated: true }).map(t => t.id);
    expect(ids).toContain('plan.propose');
    expect(ids).toContain('plan.execute');
    expect(ids).toContain('file.read');
    expect(ids).not.toContain('file.write');
    expect(ids).not.toContain('bash');
  });
  it('goal mounts structured acceptance and verification', () => {
    const s = session('goal');
    store.updateSessionMetadata(s.id, { plan: { status: 'approved' } });
    expect(toolRegistry.listForSession(s.id).map(t => t.id)).toEqual(expect.arrayContaining(['work.checkpoint', 'goal.finish', 'verification.run']));
  });
  it.each(['chat', 'plan'] as const)('%s final text is not subject to receipt or stale goal acceptance', async mode => {
    const { s, input } = active(mode);
    store.updateSessionMetadata(s.id, { goal: { objective: 'Old goal', status: 'blocked', reason: 'Old blocker' } });
    const w = workStore.current(s.id)!;
    w.hasChanges = true; w.changeVersion = 2;
    w.verifications = [{ runId: input.runId, toolCallId: 'stale-proof', criterion: 'Old check', purpose: 'Old check', command: 'false', workdir: '.', scope: ['.'], fingerprint: 'old', changeVersion: 1, status: 'failed', startedAt: '', completedAt: '', external: true }];
    workStore.save(w);
    expect(goalStopReason(store.getSession(s.id))).toBeNull();
    await workRuntime.complete(input, 'Implemented; verification could not be completed.');
    expect(store.getSession(s.id).resultSummary).toBe('Implemented; verification could not be completed.');
    expect(store.getSession(s.id).status).toBe('completed');
    expect(store.getSession(s.id).sessionMetadata?.goal).toMatchObject({ status: 'blocked' });
  });
  it('chat can end with unfinished TODOs without falsely completing them', async () => {
    const { s, input } = active('chat');
    const tasks = new TaskStore(); tasks.create('Remaining work', 'Not done'); tasks.persist(s.id);
    await workRuntime.complete(input, 'Partial result; remaining work is not done.');
    expect(store.getRun(input.runId).metadata.roundHandoff).toMatchObject({ summary: 'Partial result; remaining work is not done.' });
    expect(TaskStore.fromEvents(s.id).list()[0].status).toBe('pending');
    expect(workStore.current(s.id)?.status).toBe('active');
  });
  it.each(['chat', 'plan'] as const)('%s reminders do not request goal control tools', mode => {
    const { s } = active(mode);
    expect(workRuntime.prompt(s.id)).not.toMatch(/work\.checkpoint|goal\.finish|verification\.run/);
    expect(buildLoopStepNote({ stepIndex: 50, maxSteps: 50, converging: true, mode })).not.toMatch(/work\.checkpoint|goal\.finish/);
  });
  it('children inherit the root workflow even with stale local metadata', () => {
    const parent = session('chat');
    const child = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'explorer', parentSessionId: parent.id, prompt: 'Subtask', sessionMetadata: { mode: 'goal' } });
    const ids = toolRegistry.listForSession(child.id, { includeGated: true }).map(t => t.id);
    expect(ids).not.toContain('work.checkpoint');
    expect(ids).not.toContain('verification.run');
  });
});
