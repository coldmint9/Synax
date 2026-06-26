import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  resolveInitialSessionTitle,
  generateSessionTitle,
  scheduleSessionTitleAfterRunStart,
  maybeScheduleSessionTitleFromStreamChunk,
  ensureSessionTitleGenerated,
  isValidGeneratedSessionTitle,
} from '../session-title-service.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { nowIso } from '../runtime-ids.js';

vi.mock('../../llm-runtime/gateway.js', () => ({
  generateGatewayTextResult: vi.fn(),
}));

import { generateGatewayTextResult } from '../../llm-runtime/gateway.js';

const mockGenerateGatewayTextResult = vi.mocked(generateGatewayTextResult);

describe('resolveInitialSessionTitle', () => {
  it('uses placeholder title for agent page draft sessions', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: { source: 'session-page', goalContent: '帮我看看认证模块' },
      prompt: '帮我看看认证模块',
    })).toBe('new agent');
  });

  it('uses goalContent from session metadata', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: { goalContent: '你好，帮我看看认证模块' },
      prompt: '## User Goal\nIgnored',
    })).toBe('你好，帮我看看认证模块');
  });

  it('truncates long user input', () => {
    const long = 'a'.repeat(100);
    const title = resolveInitialSessionTitle({
      sessionMetadata: { goalContent: long },
      prompt: '',
    });
    expect(title).toHaveLength(80);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('uses short non-system prompts as provisional titles', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: null,
      prompt: 'Plan a bounded implementation slice.',
    })).toBe('Plan a bounded implementation slice.');
  });

  it('skips long system-style prompts without extractable goal', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: null,
      prompt: 'You are a Goal Agent\n\n## Instructions\nDo things',
    })).toBeNull();
  });
});

describe('session title after first run', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
    mockGenerateGatewayTextResult.mockReset();
    mockGenerateGatewayTextResult.mockResolvedValue({ text: '问候用户' } as Awaited<ReturnType<typeof generateGatewayTextResult>>);
  });

  it('does not generate title on run_started (waits for stream_done)', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '你好',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '你好' },
    });
    expect(session.title).toBe('new agent');

    const run = agentRuntimeStore.appendRun({
      id: 'run_title_test',
      sessionId: session.id,
      status: 'running',
      triggerMessageId: null,
      startedAt: nowIso(),
      completedAt: null,
      stopReason: null,
      model: null,
      currentStep: 0,
      metadata: {},
    });

    maybeScheduleSessionTitleFromStreamChunk(session.id, { type: 'run_started', run });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agentRuntimeStore.getSession(session.id).title).toBe('new agent');
    expect(mockGenerateGatewayTextResult).not.toHaveBeenCalled();
  });

  it('scheduleSessionTitleAfterRunStart generates title for placeholder sessions', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '你好',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '你好' },
    });

    const run = agentRuntimeStore.appendRun({
      id: 'run_direct_title',
      sessionId: session.id,
      status: 'running',
      triggerMessageId: null,
      startedAt: nowIso(),
      completedAt: null,
      stopReason: null,
      model: null,
      currentStep: 0,
      metadata: {},
    });

    scheduleSessionTitleAfterRunStart(session.id, run.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe('问候用户');
    });
  });

  it('generateSessionTitle always uses LLM for synax sessions', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '你好',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '你好' },
    });

    await generateSessionTitle(session.id, session.projectId, session.profileId, session.prompt);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe('问候用户');
    });
    expect(mockGenerateGatewayTextResult).toHaveBeenCalled();
  });

  it('ensureSessionTitleGenerated updates placeholder title after stream', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '你好',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '你好' },
    });
    expect(session.title).toBe('new agent');

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe('问候用户');
    });
    expect(mockGenerateGatewayTextResult).toHaveBeenCalled();
  });

  it('keeps placeholder title when LLM returns empty text', async () => {
    mockGenerateGatewayTextResult.mockResolvedValue({ text: '' } as Awaited<ReturnType<typeof generateGatewayTextResult>>);
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '你好',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '你好' },
    });

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe('你好');
    });
    expect(agentRuntimeStore.getSession(session.id).sessionMetadata?.titleSummarized).toBe(true);
  });

  it('falls back to truncated user input when LLM title fails validation', async () => {
    mockGenerateGatewayTextResult.mockResolvedValue({
      text: 'This is a much too long English title that should never pass validation',
    } as Awaited<ReturnType<typeof generateGatewayTextResult>>);
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: '帮我看看认证模块',
      sessionMetadata: { mode: 'goal', source: 'session-page', goalContent: '帮我看看认证模块' },
    });

    ensureSessionTitleGenerated(session.id);

    await vi.waitFor(() => {
      expect(agentRuntimeStore.getSession(session.id).title).toBe('帮我看看认证模块');
    });
  });
});

describe('isValidGeneratedSessionTitle', () => {
  it('accepts short Chinese titles', () => {
    expect(isValidGeneratedSessionTitle('问候用户')).toBe(true);
  });

  it('accepts short English titles', () => {
    expect(isValidGeneratedSessionTitle('Fix auth module')).toBe(true);
  });

  it('rejects overly long English titles', () => {
    expect(isValidGeneratedSessionTitle('one two three four five six seven')).toBe(false);
  });

  it('rejects overly long Chinese titles', () => {
    expect(isValidGeneratedSessionTitle('一二三四五六七八九十甲')).toBe(false);
  });
});
