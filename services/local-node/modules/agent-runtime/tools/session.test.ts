import { describe, expect, it, vi } from 'vitest';
import {
  SessionQueryError,
  type SessionStatusResult,
} from '../session-query/index.js';
import {
  createSessionListTool,
  createSessionSearchTool,
  createSessionStatusTool,
  sessionTools,
} from './session.js';

const input = (args: unknown = {}, sessionId = 'agent') =>
  ({ sessionId, args }) as never;

describe('agent session tools', () => {
  it('registers three read-only session capabilities', () => {
    expect(sessionTools.map((tool) => tool.id)).toEqual([
      'session.list',
      'session.status',
      'session.search',
    ]);
    for (const tool of sessionTools) {
      expect(tool).toMatchObject({
        category: 'read',
        mutability: 'read',
        internalGate: 'none',
        resumeBehavior: 'auto',
      });
      expect(tool.description.trim()).not.toBe('');
    }
  });

  it('parses defaults before listing and reports the page summary', async () => {
    const list = vi.fn(async () => ({
      scope: 'project' as const,
      projectId: 'project-alpha',
      items: [],
      totalCount: 7,
      hasMore: true,
      nextOffset: 20,
      countByStatus: { running: 1 },
    }));
    const tool = createSessionListTool({ list });
    const result = await tool.execute(input({}));
    expect(list).toHaveBeenCalledWith(
      {
        scope: 'project',
        includeChildren: false,
        includeArchived: false,
        limit: 20,
        offset: 0,
      },
      'agent',
    );
    expect(result.displaySummary).toBe('会话 0/7 · 还有更多');
    expect(result.result).toMatchObject({ totalCount: 7, nextOffset: 20 });
  });

  it('defaults status to the current session and maps query failures', async () => {
    const status = vi.fn(async (): Promise<SessionStatusResult> => ({
      items: [{ id: 'agent' } as SessionStatusResult['items'][number]],
      missing: ['ghost'],
    }));
    const tool = createSessionStatusTool({ status });
    const result = await tool.execute(input({}));
    expect(status).toHaveBeenCalledWith(
      { includeChildren: false },
      'agent',
    );
    expect(result.displaySummary).toBe('会话状态 1 · 缺失 1');

    const failing = createSessionStatusTool({
      status: async () => {
        throw new SessionQueryError('SESSION_NOT_FOUND', 'Session ghost was not found.');
      },
    });
    expect(await failing.execute(input({ sessionIds: ['ghost'] }))).toMatchObject({
      outcome: 'failed',
      result: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('reports bounded search summaries and lets internal errors surface', async () => {
    const search = vi.fn(async () => ({
      query: 'deploy',
      scope: 'project' as const,
      projectId: 'project-alpha',
      candidateSessions: 8,
      scannedSessions: 3,
      truncated: true,
      items: [],
      missing: [],
    }));
    const tool = createSessionSearchTool({ search });
    const result = await tool.execute(input({ query: 'deploy' }));
    expect(result.displaySummary).toBe('检索 0 · 已截断 · 扫描 3/8');
    expect(() => tool.inputSchema!.parse({ query: 'd' })).toThrow();
    expect(() =>
      tool.inputSchema!.parse({
        query: 'deploy',
        sessionIds: ['a'],
        scope: 'all',
      }),
    ).toThrow(/cannot be combined/);

    const broken = createSessionSearchTool({
      search: async () => {
        throw new Error('boom');
      },
    });
    await expect(broken.execute(input({ query: 'deploy' }))).rejects.toThrow(
      'boom',
    );
  });
});
