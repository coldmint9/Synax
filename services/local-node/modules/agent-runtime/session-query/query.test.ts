import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../contracts.js';
import {
  collapseWhitespace,
  compareSearchHits,
  compareSessions,
  countByStatus,
  countMatches,
  isVisibleSession,
  selectSessions,
  sessionStatusOf,
  snippetAround,
  toSessionListItem,
  toSessionStatusItem,
  truncateText,
} from './query.js';

function session(
  id: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id,
    projectId: 'project-alpha',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'completed',
    title: null,
    prompt: 'Prompt text',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    permissionRules: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
    ...overrides,
  };
}

describe('session read model', () => {
  it('hides deleted and fork-preparing rows, archived rows unless requested, and children by default', () => {
    const rows = [
      session('root'),
      session('child', { parentSessionId: 'root' }),
      session('archived', { sessionMetadata: { archivedAt: '2026-01-02' } }),
      session('deleted', { sessionMetadata: { deletedAt: '2026-01-02' } }),
      session('forking', { sessionMetadata: { forkPreparing: true } }),
    ];
    expect(selectSessions(rows).map((item) => item.id)).toEqual(['root']);
    expect(
      selectSessions(rows, { includeChildren: true }).map((item) => item.id),
    ).toEqual(['root', 'child']);
    expect(
      selectSessions(rows, { includeArchived: true }).map((item) => item.id),
    ).toEqual(['root', 'archived']);
    expect(isVisibleSession(rows[3], true)).toBe(false);
  });

  it('scopes by project and projects legacy statuses before filtering', () => {
    const rows = [
      session('alpha', { status: 'cancelled', profileId: 'synax' }),
      session('beta', { projectId: 'project-beta', status: 'cancelled' }),
      session('gamma', {
        projectId: 'project-other',
        status: 'cancelled',
        profileId: 'planner',
      }),
    ];
    expect(sessionStatusOf(rows[0])).toBe('completed');
    expect(
      selectSessions(rows, {
        projectId: 'project-alpha',
        statuses: ['completed'],
      }).map((item) => item.id),
    ).toEqual(['alpha']);
    expect(countByStatus(rows)).toEqual({ completed: 2, cancelled: 1 });
  });

  it('sorts pinned sessions first and keeps a stable id order', () => {
    const rows = [
      session('newest', { updatedAt: '2026-01-03T00:00:00.000Z' }),
      session('pinned', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        sessionMetadata: { pinned: true },
      }),
      session('b', { updatedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const sorted = selectSessions(rows).sort(compareSessions);
    expect(sorted.map((item) => item.id)).toEqual(['pinned', 'newest', 'b']);
    expect(toSessionListItem(rows[1]).pinned).toBe(true);
  });

  it('builds compact list rows without leaking session metadata', () => {
    const row = session('agent', {
      title: '  Fix   the flaky test  ',
      prompt: 'a'.repeat(400),
      blockedReason: 'waiting for approval',
      activeRunId: 'run-1',
      sessionMetadata: { pinned: true, archivedAt: '2026-02-01', secret: 'x' },
    });
    const item = toSessionListItem(row);
    expect(item).toMatchObject({
      id: 'agent',
      title: 'Fix the flaky test',
      pinned: true,
      archived: true,
      activeRunId: 'run-1',
      blockedReason: 'waiting for approval',
    });
    expect(item.promptPreview).toHaveLength(160);
    expect(item.promptPreview.endsWith('…')).toBe(true);
    expect(item).not.toHaveProperty('sessionMetadata');
  });

  it('summarizes status with analytics and bounded children', () => {
    const parent = session('parent', {
      status: 'running',
      activeRunId: 'run-1',
      runtimeRecoveryRequired: true,
      sessionMetadata: {
        runtimeAnalytics: {
          version: 1,
          updatedAt: '2026-01-02T00:00:00.000Z',
          steps: 4,
          completedRuns: 2,
          completedRunSteps: 4,
          toolCalls: 7,
          toolCounts: {},
          usage: {},
          models: {},
          lastStepId: 'step-4',
          lastCompletedRunId: 'run-0',
        },
      },
    });
    const children = Array.from({ length: 25 }, (_, index) =>
      session(`child-${index}`, {
        parentSessionId: 'parent',
        updatedAt: `2026-01-02T00:00:${String(25 - index).padStart(2, '0')}.000Z`,
      }),
    );
    const item = toSessionStatusItem(parent, children);
    expect(item).toMatchObject({
      id: 'parent',
      status: 'running',
      activeRunId: 'run-1',
      runtimeRecoveryRequired: true,
      analytics: { steps: 4, toolCalls: 7, lastCompletedRunId: 'run-0' },
    });
    expect(item.children).toHaveLength(20);
    expect(item.children[0]).toMatchObject({ id: 'child-0', status: 'completed' });
  });

  it('snippets around the match and counts without runaway loops', () => {
    expect(collapseWhitespace(' a\n\n b  c ')).toBe('a b c');
    expect(truncateText('abcdef', 4)).toBe('abc…');
    const text = `${'x'.repeat(120)}needle${'y'.repeat(120)}`;
    const snippet = snippetAround(text, 120, 'needle'.length);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(countMatches('Needle needle NEEDLE', 'needle')).toBe(3);
    expect(countMatches('x'.repeat(1000), 'x', 20)).toBe(20);
  });

  it('orders search hits by session recency, then kind', () => {
    const base = {
      sessionId: 'a',
      title: null,
      status: 'completed' as const,
      sessionUpdatedAt: '2026-01-02T00:00:00.000Z',
      messageId: null,
      role: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      snippet: '…',
      matchCount: 1,
    };
    const hits = [
      { ...base, kind: 'message' as const },
      { ...base, kind: 'title' as const },
      {
        ...base,
        kind: 'message' as const,
        sessionId: 'b',
        sessionUpdatedAt: '2026-01-03T00:00:00.000Z',
      },
    ].sort(compareSearchHits);
    expect(hits.map((hit) => `${hit.sessionId}:${hit.kind}`)).toEqual([
      'b:message',
      'a:title',
      'a:message',
    ]);
  });
});
