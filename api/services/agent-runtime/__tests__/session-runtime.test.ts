import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { toolRegistry } from '../tool-registry.js';
import { executorInput, explorerSessionInput, plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('agentSessionRuntime', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('creates a role-specific session with context and start event', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const events = agentRuntimeStore.listEvents(session.id);

    expect(session.status).toBe('running');
    expect(session.contextSnapshotId).toMatch(/^acb_/);
    expect(events.map((event) => event.type)).toContain('session_started');
  });

  it('links read-only sub-sessions to their parent and inherits rules', () => {
    const parent = agentSessionRuntime.create(plannerSessionInput);
    const child = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: parent.id,
    });

    expect(child.parentSessionId).toBe(parent.id);
    expect(agentRuntimeStore.getSession(parent.id).childSessionIds).toContain(child.id);
    expect(child.permissionRules.length).toBeGreaterThan(0);
  });

  it('pauses on gated write tool requests', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const call = await toolRegistry.execute(session.id, 'file.write', {
      path: 'tmp/agent-runtime-test.txt',
      content: 'hello',
    });

    expect(call.record.status).toBe('pending');
    expect(agentRuntimeStore.getSession(session.id).status).toBe('waiting_permission');
    expect(agentRuntimeStore.listPermissions(session.id)[0].action).toBe('ask');
  });

  it('stops a session and leaves it resumable', () => {
    const session = agentSessionRuntime.create(executorInput);
    const stopped = agentSessionRuntime.cancel(session.id);

    expect(stopped.status).toBe('interrupted');
    expect(stopped.activeRunId).toBeNull();
    expect(stopped.pendingResumeToken).toBeNull();
    expect(stopped.completedAt).toBeNull();
    expect(agentRuntimeStore.listEvents(session.id).map((event) => event.summary)).toContain('Session stopped');
  });

  it('deletes a session tree and cascades all runtime records', () => {
    const parent = agentSessionRuntime.create(executorInput);
    const child = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: parent.id,
    });
    const now = new Date().toISOString();

    agentRuntimeStore.appendMessage({
      id: 'msg-parent',
      sessionId: parent.id,
      runId: null,
      stepId: null,
      role: 'assistant',
      content: 'Parent message.',
      metadata: {},
      createdAt: now,
    });
    agentRuntimeStore.appendEvent({
      id: 'evt-parent',
      sessionId: parent.id,
      type: 'progress_updated',
      timestamp: now,
      visibility: 'user_visible',
      summary: 'Parent event.',
      payload: {},
    });
    const run = agentRuntimeStore.appendRun({
      id: 'run-parent',
      sessionId: parent.id,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: 'completed',
      model: 'gpt-test',
      metadata: {},
    });
    const step = agentRuntimeStore.appendRunStep({
      id: 'step-parent',
      runId: run.id,
      sessionId: parent.id,
      index: 1,
      status: 'completed',
      model: 'gpt-test',
      startedAt: now,
      completedAt: now,
      finishReason: 'stop',
      metadata: {},
    });
    agentRuntimeStore.appendRunPart({
      id: 'part-parent',
      runId: run.id,
      stepId: step.id,
      sessionId: parent.id,
      kind: 'text',
      sequence: 1,
      content: 'Parent part.',
      toolCallId: null,
      metadata: {},
      createdAt: now,
    });
    agentRuntimeStore.appendToolCall({
      id: 'tool-parent',
      sessionId: parent.id,
      runId: run.id,
      stepId: step.id,
      modelToolCallId: null,
      toolId: 'file.read',
      category: 'read',
      mutability: 'read',
      argsHash: 'hash-parent',
      inputSummary: 'Read file',
      inputRef: { path: 'README.md' },
      outputSummary: 'Done',
      outputRef: null,
      status: 'completed',
      permissionDecisionId: null,
      startedAt: now,
      endedAt: now,
      error: null,
    });
    agentRuntimeStore.appendPermission({
      id: 'perm-parent',
      sessionId: parent.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: 'tool-parent',
      coarseCategory: 'read',
      internalGate: 'none',
      action: 'allow',
      reason: 'Allowed.',
      patterns: ['README.md'],
      userReply: 'once',
      createdAt: now,
      resolvedAt: now,
      resumeToken: null,
      metadata: {},
    });
    agentRuntimeStore.appendArtifact({
      id: 'art-parent',
      sessionId: parent.id,
      kind: 'decision',
      title: 'Artifact',
      summary: 'Parent artifact.',
      sourceRefs: [],
      risk: 'low',
      metadata: {},
      createdAt: now,
    });
    agentRuntimeStore.saveThinkingSummary({
      id: 'think-parent',
      sessionId: parent.id,
      mode: 'standard',
      framing: 'Frame',
      evidenceUsed: [],
      decision: 'Delete',
      assumptions: [],
      risks: [],
      nextSteps: [],
    });

    const deletedSessionIds = agentSessionRuntime.delete(parent.id);

    expect(deletedSessionIds).toEqual([parent.id, child.id]);
    expect(agentRuntimeStore.listSessions({ projectId: parent.projectId })).toHaveLength(0);
    expect(agentRuntimeStore.listMessages(parent.id)).toHaveLength(0);
    expect(agentRuntimeStore.listEvents(parent.id)).toHaveLength(0);
    expect(agentRuntimeStore.listRuns(parent.id)).toHaveLength(0);
    expect(agentRuntimeStore.listPermissions(parent.id)).toHaveLength(0);
    expect(agentRuntimeStore.listArtifacts(parent.id)).toHaveLength(0);
    expect(agentRuntimeStore.listToolCalls(parent.id)).toHaveLength(0);
    expect(() => agentRuntimeStore.getContextBundle(parent.contextSnapshotId!)).toThrow(/not found/i);
    expect(() => agentRuntimeStore.getThinkingSummary('think-parent')).toThrow(/not found/i);
    expect(() => agentRuntimeStore.getSession(parent.id)).toThrow(/not found/i);
    expect(() => agentRuntimeStore.getSession(child.id)).toThrow(/not found/i);
  });

  it('removes deleted child sessions from the surviving parent', () => {
    const parent = agentSessionRuntime.create(plannerSessionInput);
    const child = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: parent.id,
    });

    const deletedSessionIds = agentSessionRuntime.delete(child.id);

    expect(deletedSessionIds).toEqual([child.id]);
    expect(agentRuntimeStore.getSession(parent.id).childSessionIds).not.toContain(child.id);
  });
});
