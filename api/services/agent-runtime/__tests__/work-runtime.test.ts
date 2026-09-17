import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { toolRegistry as agentToolRegistry } from '../tool-registry.js';
import { workRuntime } from '../work-runtime.js';
import { workStore } from '../work-store.js';
import { inputQueueService } from '../input-queue-service.js';
import { goalContinuationInput } from '../goal-continuation.js';
import { workCheckpointTool } from '../tools/work-tools.js';
import { TaskStore } from '../tools/task-tools.js';
import { setSessionWorkspaceRoot } from '../tools/workspace.js';
import { resetAgentRuntimeFixtures, executorInput } from './agent-runtime-fixtures.js';
import { nowIso } from '../runtime-ids.js';
import type { ToolExecutionInput } from '../contracts.js';

let root: string;
let seq = 0;
beforeEach(() => { resetAgentRuntimeFixtures(); seq = 0; root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-work-fixture-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function setup(prompt = 'Fix one file and verify it') {
  const session = agentSessionRuntime.create({ ...executorInput, prompt, permissionTier: 'unrestricted' });
  setSessionWorkspaceRoot(session.id, root);
  const run = nextRun(session.id, prompt);
  return { session, run };
}
function nextRun(sessionId: string, prompt: string) {
  const id = `run-${++seq}`;
  const msg = store.appendMessage({ id: `msg-${seq}`, sessionId, runId: null, stepId: null, role: 'user', content: prompt, metadata: { source: 'turn_request' }, createdAt: nowIso() });
  const run = store.appendRun({ id, sessionId, status: 'running', startedAt: nowIso(), completedAt: null, triggerMessageId: msg.id, currentStep: 0, stopReason: null, model: null, metadata: {} });
  store.updateSession(sessionId, { status: 'running', activeRunId: run.id });
  workRuntime.attach(sessionId, run);
  return store.getRun(run.id);
}
function step(sessionId: string, runId: string) {
  const id = `step-${++seq}`;
  store.appendRunStep({ id, sessionId, runId, index: seq, status: 'completed', startedAt: nowIso(), completedAt: nowIso(), model: null, finishReason: 'tool-calls', metadata: { workId: workStore.current(sessionId)!.id } });
  return id;
}
function input(sessionId: string, runId: string, args: unknown): ToolExecutionInput {
  return { sessionId, runId, stepId: step(sessionId, runId), toolCallId: `tc-checkpoint-${seq}`, toolId: 'work.checkpoint', category: 'task', mutability: 'task', args };
}

describe('durable cooperative work runtime', () => {
  it('keeps ordinary queued input waiting across an approved goal round handoff', () => {
    const { session, run } = setup();
    const items = inputQueueService.enqueue(session.id, { message: 'Next independent task' });
    expect(() => workRuntime.yieldRound(input(session.id, run.id, {}), 'Continue the current task', 'Finish remaining work')).not.toThrow();
    store.updateSessionMetadata(session.id, {
      mode: 'goal',
      goal: { objective: 'Finish current task', status: 'executing' },
      plan: {
        title: 'Current plan', objective: 'Finish current task', revision: 1,
        status: 'approved', executionId: 'execution-1', acceptanceCriteria: ['Done'],
        steps: [{ id: 's1', title: 'Finish', description: 'Finish current task', dependsOn: [], expectedFiles: [] }],
      },
    });
    store.updateRun(run.id, { status: 'completed', stopReason: 'round_yielded',
      metadata: { ...store.getRun(run.id).metadata, goalExecutionId: 'execution-1' } });
    store.updateSession(session.id, { status: 'completed', activeRunId: null });
    expect(goalContinuationInput(session.id, run.id)?.messageSource).toBe('system_injection');
    expect(inputQueueService.list(session.id)).toEqual(items);
    inputQueueService.markForceInject(session.id, items[0].id);
    expect(goalContinuationInput(session.id, run.id)?.messageSource).toBe('system_injection');
  });

  it('requires a forced steering message to be processed before yielding', () => {
    const { session, run } = setup();
    const items = inputQueueService.enqueue(session.id, { message: 'Change current direction' });
    inputQueueService.markForceInject(session.id, items[0].id);
    expect(() => workRuntime.yieldRound(input(session.id, run.id, {}), 'Pause')).toThrow(/user input is waiting/i);
  });

  it('reuses work and stall state across continue runs', () => {
    const { session } = setup();
    const original = workStore.current(session.id)!;
    original.noProgressSteps = 2; workStore.save(original);
    const next = nextRun(session.id, '继续');
    expect(next.metadata.workId).toBe(original.id);
    expect(workStore.current(session.id)?.noProgressSteps).toBe(2);
  });

  it('retains a completed result on continue without reopening work', async () => {
    const { session, run } = setup('Explain an already known fact');
    await workRuntime.complete(input(session.id, run.id, {}), 'The answer is available.');
    const original = workStore.current(session.id)!;
    nextRun(session.id, '继续');
    expect(workStore.current(session.id)).toMatchObject({ id: original.id, status: 'completed', result: 'The answer is available.' });
  });

  it('all TODOs done triggers a decision, not automatic success', () => {
    const { session, run } = setup();
    const tasks = new TaskStore(); const task = tasks.create('Implement', 'One focused change');
    tasks.update(task.id, { status: 'completed' }); tasks.persist(session.id);
    workRuntime.afterStep(session.id, step(session.id, run.id), workStore.current(session.id)!.progressVersion);
    expect(workStore.current(session.id)?.status).toBe('closing');
    expect(store.getRun(run.id).status).toBe('running');
    expect(workRuntime.toolError(session.id, 'bash')).toMatch(/closing decision/);
  });

  it('stalled steps nudge, gate, and release the closing decision without blocking', async () => {
    const { session, run } = setup();
    const doStall = (steps: number) => {
      for (let n = 0; n < steps; n++) {
        const w = workStore.current(session.id)!;
        workRuntime.afterStep(session.id, step(session.id, run.id), w.progressVersion);
      }
    };
    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', noProgressSteps: 3 });
    expect(workStore.current(session.id)?.reason).toMatch(/No new information/);
    expect(workRuntime.toolError(session.id, 'bash')).toBeNull();

    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({ status: 'closing', noProgressSteps: 6 });
    expect(workRuntime.toolError(session.id, 'bash')).toMatch(/closing decision/);

    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', decisionFailures: 0 });
  });

  it('new read discoveries and negative search results remain progress', () => {
    const { session, run } = setup();
    for (let n = 0; n < 6; n++) {
      const before = workStore.current(session.id)!.progressVersion;
      const stepId = step(session.id, run.id);
      const call = store.appendToolCall({ id: `read-${n}`, sessionId: session.id, runId: run.id, stepId, modelToolCallId: null, toolId: 'grep.search', category: 'read', mutability: 'read', argsHash: `hash-${n}`, inputRef: { query: `hypothesis-${n}`, path: '.' }, inputSummary: '', outputRef: { matches: [] }, outputSummary: 'No matches', status: 'completed', permissionDecisionId: null, startedAt: nowIso(), endedAt: nowIso(), error: null });
      workRuntime.recordTool(call); workRuntime.afterStep(session.id, stepId, before);
    }
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', noProgressSteps: 0 });
  });

  it('requires current-version verification after changes and rejects stale/cross-work proof', async () => {
    const { session, run } = setup();
    fs.writeFileSync(path.join(root, 'source.txt'), 'first');
    const w = workStore.current(session.id)!; w.hasChanges = true; w.changeVersion++; workStore.save(w);
    await expect(workRuntime.complete(input(session.id, run.id, {}), 'Done')).rejects.toThrow('Missing current-version verification');
    const result = await agentToolRegistry.execute(session.id, 'verification.run', {
      command: `node -e "if(require('fs').readFileSync('source.txt','utf8')!=='first')process.exit(1)"`,
      criterion: 'Source is correct', purpose: 'Check the changed file', scope: ['source.txt'],
    }, { runId: run.id, stepId: step(session.id, run.id) });
    expect(result.record.error).toBeNull();
    expect((result.record.outputRef as any).verification.status).toBe('success');
    await expect(workRuntime.complete(input(session.id, run.id, {}), 'Done', [{ criterion: 'Source', summary: 'checked', toolCallIds: ['foreign-proof'] }])).rejects.toThrow('belong to this work');
    fs.writeFileSync(path.join(root, 'source.txt'), 'changed later');
    await expect(workRuntime.complete(input(session.id, run.id, {}), 'Done')).rejects.toThrow('current-version verification');
    fs.writeFileSync(path.join(root, 'source.txt'), 'first');
    await workRuntime.complete(input(session.id, run.id, {}), 'Verified change delivered');
    expect(store.getSession(session.id).status).toBe('completed');
    expect(store.getRun(run.id).status).toBe('completed');
  });

  it('forbids automatic stash baselines and unscoped validation without a risk', async () => {
    const { session, run } = setup();
    expect(workRuntime.toolError(session.id, 'bash', { command: 'git stash push -u -m baseline-check' })).toMatch(/explicit user/);
    const result = await agentToolRegistry.execute(session.id, 'verification.run', { command: 'npm test', criterion: 'Filter', purpose: 'Just in case', scope: ['.'] }, { runId: run.id, stepId: step(session.id, run.id) });
    expect(result.record.error).toMatch(/unresolved risk/);
  });

  it('context references cannot read another session', async () => {
    const a = setup(); const b = setup();
    const result = await agentToolRegistry.execute(a.session.id, 'context.read', { kind: 'work', id: workStore.current(b.session.id)!.id }, { runId: a.run.id, stepId: step(a.session.id, a.run.id) });
    expect(result.record.error).toMatch(/accessible session/);
  });
});
