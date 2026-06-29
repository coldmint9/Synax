import { beforeEach, describe, expect, it } from 'vitest';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { isAcpModel, parseAcpModel } from '../acp-engine/acp-model.js';
import {
  resolveSessionEngineModel,
  sessionUsesAcpEngine,
  shouldUseAcpEngine,
} from '../acp-engine/acp-engine-routing.js';
import { mergeAcpSessionMetadata } from '../acp-engine/acp-session-metadata.js';
import { AcpUpdateMapper } from '../acp-engine/acp-update-mapper.js';
import { makeRuntimeId, nowIso } from '../runtime-ids.js';

describe('acp engine routing', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('detects ACP model ids', () => {
    expect(isAcpModel('cursor-acp/default')).toBe(true);
    expect(isAcpModel('opencode-acp/default')).toBe(true);
    expect(isAcpModel('anthropic/claude-3')).toBe(false);
    expect(parseAcpModel('cursor-acp/default')).toEqual({
      providerId: 'cursor-acp',
      modelId: 'default',
    });
  });

  it('routes sessions by turn model and persisted metadata', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    expect(shouldUseAcpEngine(session.id, { model: 'cursor-acp/default' })).toBe(true);
    expect(shouldUseAcpEngine(session.id, {})).toBe(false);

    agentRuntimeStore.updateSession(session.id, {
      sessionMetadata: mergeAcpSessionMetadata(session, {
        providerId: 'cursor-acp',
        acpSessionId: 'acp_sess_1',
        engineModel: 'cursor-acp/default',
      }),
      updatedAt: nowIso(),
    });
    expect(resolveSessionEngineModel(session.id, {})).toBe('cursor-acp/default');
    expect(sessionUsesAcpEngine(session.id)).toBe(true);
  });
});

describe('acp update mapper', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
  });

  it('maps message and tool call updates into stream chunks', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: makeRuntimeId('run'),
      sessionId: session.id,
      status: 'running',
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: 'cursor-acp/default',
      metadata: {},
    });
    const step = agentRuntimeStore.appendRunStep({
      id: makeRuntimeId('step'),
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'running',
      model: 'cursor-acp/default',
      startedAt: nowIso(),
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    const mapper = new AcpUpdateMapper({
      sessionId: session.id,
      run,
      step,
      isReplay: false,
    });

    const messageChunks = mapper.mapUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello' },
    });
    expect(messageChunks).toHaveLength(1);
    expect(messageChunks[0]).toMatchObject({
      type: 'message_delta',
      delta: 'Hello',
    });

    const toolChunks = mapper.mapUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_1',
      kind: 'read',
      title: 'Read file',
      status: 'pending',
    });
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]?.type).toBe('tool_call');

    const resultChunks = mapper.mapUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc_1',
      status: 'completed',
      title: 'Read file done',
    });
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]?.type).toBe('tool_result');

    const assistant = mapper.finalizeAssistantMessage();
    expect(assistant?.content).toBe('Hello');
    expect(agentRuntimeStore.listMessages(session.id)).toHaveLength(1);
  });

  it('persists usage_update into run step metadata', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: makeRuntimeId('run'),
      sessionId: session.id,
      status: 'running',
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: 'cursor-acp/default',
      metadata: {},
    });
    const step = agentRuntimeStore.appendRunStep({
      id: makeRuntimeId('step'),
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'running',
      model: 'cursor-acp/default',
      startedAt: nowIso(),
      completedAt: null,
      finishReason: null,
      metadata: { engine: 'acp' },
    });
    const mapper = new AcpUpdateMapper({
      sessionId: session.id,
      run,
      step,
      isReplay: false,
    });

    expect(mapper.mapUpdate({
      sessionUpdate: 'usage_update',
      used: 48_000,
      size: 200_000,
    })).toEqual([]);

    const updated = agentRuntimeStore.getRunStep(step.id);
    expect(updated.metadata.usage).toEqual({
      inputTokens: 48_000,
      contextWindowSize: 200_000,
      source: 'acp',
    });
    expect(mapper.getAccumulatedUsage()).toEqual(updated.metadata.usage);
  });

  it('skips persistence during replay', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: makeRuntimeId('run'),
      sessionId: session.id,
      status: 'running',
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: 'cursor-acp/default',
      metadata: {},
    });
    const step = agentRuntimeStore.appendRunStep({
      id: makeRuntimeId('step'),
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'running',
      model: 'cursor-acp/default',
      startedAt: nowIso(),
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    const mapper = new AcpUpdateMapper({
      sessionId: session.id,
      run,
      step,
      isReplay: true,
    });
    expect(mapper.mapUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Replay' },
    })).toEqual([]);
  });
});
