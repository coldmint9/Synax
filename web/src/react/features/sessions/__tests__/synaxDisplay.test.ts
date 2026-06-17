import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../../../lib/api/agentRuntime';
import { resolveSynaxAgentLabel, resolveSynaxRouteReason } from '../synaxDisplay';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    projectId: 'p1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'running',
    title: null,
    prompt: 'test',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  };
}

describe('synaxDisplay', () => {
  it('shows variant label when active', () => {
    expect(resolveSynaxAgentLabel(makeSession({
      sessionMetadata: { mode: 'chat', activeVariant: 'planner', routeReason: 'Planning task' },
    }))).toBe('Synax · Planner');
  });

  it('shows goal mode label', () => {
    expect(resolveSynaxAgentLabel(makeSession({
      sessionMetadata: { mode: 'goal' },
    }))).toBe('Synax · Goal');
  });

  it('falls back to plain Synax for chat', () => {
    expect(resolveSynaxAgentLabel(makeSession({
      sessionMetadata: { mode: 'chat' },
    }))).toBe('Synax');
  });

  it('exposes route reason', () => {
    expect(resolveSynaxRouteReason(makeSession({
      sessionMetadata: { routeReason: 'User asked for review' },
    }))).toBe('User asked for review');
  });
});
