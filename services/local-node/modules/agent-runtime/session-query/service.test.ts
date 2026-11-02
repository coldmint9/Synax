import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeMessage, AgentSession } from '../contracts.js';
import {
  sessionListQuerySchema,
  sessionSearchQuerySchema,
  sessionStatusQuerySchema,
} from './contracts.js';
import { SessionQueryError } from './errors.js';
import { SessionQueryService } from './service.js';
import type { SessionReader } from './contracts.js';

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

function message(
  sessionId: string,
  id: string,
  role: AgentRuntimeMessage['role'],
  content: string,
  createdAt = '2026-01-01T00:00:00.000Z',
): AgentRuntimeMessage {
  return {
    id,
    sessionId,
    runId: null,
    stepId: null,
    role,
    content,
    metadata: {},
    createdAt,
  };
}

const rows = [
  session('a', {
    status: 'running',
    activeRunId: 'run-1',
    updatedAt: '2026-01-05T00:00:00.000Z',
  }),
  session('b', {
    title: 'Flaky tests',
    prompt: 'Investigate flaky tests in CI',
    updatedAt: '2026-01-04T00:00:00.000Z',
  }),
  session('child', {
    parentSessionId: 'a',
    status: 'running',
    updatedAt: '2026-01-03T12:00:00.000Z',
  }),
  session('other', {
    projectId: 'project-beta',
    updatedAt: '2026-01-03T00:00:00.000Z',
  }),
  session('archived', {
    updatedAt: '2026-01-06T00:00:00.000Z',
    sessionMetadata: { archivedAt: '2026-01-06T01:00:00.000Z' },
  }),
  session('deleted', {
    updatedAt: '2026-01-07T00:00:00.000Z',
    sessionMetadata: { deletedAt: '2026-01-07T01:00:00.000Z' },
  }),
];

const transcripts: Record<string, AgentRuntimeMessage[]> = {
  a: [
    message('a', 'a-1', 'user', 'Hello world'),
    message('a', 'a-2', 'assistant', 'The deploy is green'),
    message('a', 'a-3', 'tool', 'needle in tool output'),
  ],
  b: [message('b', 'b-1', 'user', 'We discussed needle in the haystack')],
  child: [message('child', 'c-1', 'assistant', 'child needle')],
};

function reader(): SessionReader & {
  listSessions: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
} {
  return {
    listSessions: vi.fn(async () => rows),
    getSession: async (sessionId: string) => {
      const found = rows.find((row) => row.id === sessionId);
      if (!found)
        throw new SessionQueryError(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} was not found.`,
        );
      return found;
    },
    listMessages: vi.fn(
      async (sessionId: string) => transcripts[sessionId] ?? [],
    ),
  };
}

const service = (source: SessionReader) =>
  new SessionQueryService(source, () => 'project-alpha');

describe('session query service', () => {
  it('lists visible root sessions in the current workspace with filtered counts', async () => {
    const result = await service(reader()).list(
      sessionListQuerySchema.parse({}),
      'a',
    );
    expect(result).toMatchObject({
      scope: 'project',
      projectId: 'project-alpha',
      totalCount: 2,
      hasMore: false,
      nextOffset: null,
      countByStatus: { running: 1, completed: 1 },
    });
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.items[1]).toMatchObject({
      title: 'Flaky tests',
      promptPreview: 'Investigate flaky tests in CI',
    });
  });

  it('supports cross-workspace paging and status filters', async () => {
    const source = reader();
    const all = await service(source).list(
      sessionListQuerySchema.parse({ scope: 'all', limit: 2 }),
      'a',
    );
    expect(all.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(all.totalCount).toBe(3);
    expect(all.nextOffset).toBe(2);
    expect(all.hasMore).toBe(true);
    const running = await service(source).list(
      sessionListQuerySchema.parse({ status: ['running'] }),
      'a',
    );
    expect(running.items.map((item) => item.id)).toEqual(['a']);
    expect(() =>
      sessionListQuerySchema.parse({ scope: 'all', projectId: 'project-alpha' }),
    ).toThrow(/projectId applies only to project scope/);
  });

  it('reports one session by default and includes children on request', async () => {
    const plain = await service(reader()).status(
      sessionStatusQuerySchema.parse({}),
      'a',
    );
    expect(plain.items.map((item) => item.id)).toEqual(['a']);
    expect(plain.items[0]).toMatchObject({
      status: 'running',
      activeRunId: 'run-1',
      children: [],
    });
    const detailed = await service(reader()).status(
      sessionStatusQuerySchema.parse({ sessionIds: ['a', 'a'], includeChildren: true }),
      'a',
    );
    expect(detailed.items).toHaveLength(1);
    expect(detailed.items[0].children.map((item) => item.id)).toEqual(['child']);
  });

  it('falls back to the authoritative summary when the local mirror lacks the session', async () => {
    const result = await new SessionQueryService(reader(), () => {
      throw new Error('not hydrated');
    }).list(sessionListQuerySchema.parse({}), 'b');
    expect(result.projectId).toBe('project-alpha');
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('distinguishes a missing session from an unavailable runtime', async () => {
    const missing = await service(reader()).status(
      sessionStatusQuerySchema.parse({ sessionIds: ['a', 'ghost'] }),
      'a',
    );
    expect(missing.items.map((item) => item.id)).toEqual(['a']);
    expect(missing.missing).toEqual(['ghost']);
    const deleted = await service(reader()).status(
      sessionStatusQuerySchema.parse({ sessionIds: ['deleted'] }),
      'a',
    ).catch((error) => error);
    expect(deleted).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(
      service(reader()).status(
        sessionStatusQuerySchema.parse({ sessionIds: ['ghost'] }),
        'a',
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    const unavailable = new SessionQueryError(
      'RUNTIME_UNAVAILABLE',
      'Agent runtime history is unavailable.',
    );
    await expect(
      service({
        listSessions: async () => [],
        getSession: async () => {
          throw unavailable;
        },
        listMessages: async () => [],
      }).status(sessionStatusQuerySchema.parse({}), 'a'),
    ).rejects.toBe(unavailable);
  });

  it('returns title, prompt and message hits with source identifiers', async () => {
    const source = reader();
    const title = await service(source).search(
      sessionSearchQuerySchema.parse({ query: 'flaky' }),
      'a',
    );
    expect(title.items).toEqual([
      expect.objectContaining({
        sessionId: 'b',
        kind: 'title',
        messageId: null,
        role: null,
        matchCount: 1,
      }),
    ]);
    const prompt = await service(source).search(
      sessionSearchQuerySchema.parse({ query: 'CI', sessionIds: ['b'] }),
      'a',
    );
    expect(prompt.items[0]).toMatchObject({ kind: 'prompt', sessionId: 'b' });
    const text = await service(source).search(
      sessionSearchQuerySchema.parse({ query: 'deploy' }),
      'a',
    );
    expect(text.items).toEqual([
      expect.objectContaining({
        sessionId: 'a',
        kind: 'message',
        messageId: 'a-2',
        role: 'assistant',
      }),
    ]);
    expect(source.listMessages).toHaveBeenCalledWith('a');
  });

  it('honours roles, scan bounds, explicit ids and missing ids', async () => {
    const noTools = await service(reader()).search(
      sessionSearchQuerySchema.parse({ query: 'needle', sessionIds: ['a'] }),
      'a',
    );
    expect(noTools.items).toEqual([]);
    const tools = await service(reader()).search(
      sessionSearchQuerySchema.parse({
        query: 'needle',
        sessionIds: ['a'],
        roles: ['tool'],
      }),
      'a',
    );
    expect(tools.items[0]).toMatchObject({ messageId: 'a-3', role: 'tool' });

    const boundedReader = reader();
    const bounded = await service(boundedReader).search(
      sessionSearchQuerySchema.parse({ query: 'needle', maxSessions: 1 }),
      'a',
    );
    expect(boundedReader.listMessages).toHaveBeenCalledTimes(1);
    expect(bounded.scannedSessions).toBe(1);
    expect(bounded.truncated).toBe(true);

    const explicit = await service(reader()).search(
      sessionSearchQuerySchema.parse({
        query: 'needle',
        sessionIds: ['b', 'ghost'],
      }),
      'a',
    );
    expect(explicit.items[0]).toMatchObject({ sessionId: 'b' });
    expect(explicit.missing).toEqual(['ghost']);

    await expect(
      service(reader()).search(
        sessionSearchQuerySchema.parse({ query: 'needle', sessionIds: ['ghost'] }),
        'a',
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('keeps search scoped to the current workspace and skips child transcripts', async () => {
    const result = await service(reader()).search(
      sessionSearchQuerySchema.parse({ query: 'needle' }),
      'a',
    );
    expect(result.candidateSessions).toBe(2);
    expect(result.items.map((hit) => hit.sessionId)).toEqual(['b']);
    const withChildren = await service(reader()).search(
      sessionSearchQuerySchema.parse({ query: 'needle', includeChildren: true }),
      'a',
    );
    expect(withChildren.items.map((hit) => hit.sessionId)).toEqual([
      'b',
      'child',
    ]);
    expect(() =>
      sessionSearchQuerySchema.parse({
        query: 'needle',
        sessionIds: ['a'],
        projectId: 'project-alpha',
      }),
    ).toThrow(/cannot be combined/);
    expect(() => sessionSearchQuerySchema.parse({ query: 'n' })).toThrow();
  });
});
