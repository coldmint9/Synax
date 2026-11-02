import { describe, expect, it } from 'vitest';
import type { AgentRuntimeMessage, AgentSession } from '../../contracts.js';
import {
  MemorySessionSearchStore,
  boundDocuments,
  MAX_STORED_DOCUMENTS,
} from '../search-store.js';
import {
  SessionSearchService,
  type SessionSearchSource,
} from '../search-service.js';
import { buildSessionSearchDocument } from '../search-documents.js';
import { searchMessage as message, searchSession as session } from './search-fixtures.js';

class FakeSource implements SessionSearchSource {
  constructor(
    public sessions: AgentSession[],
    public messages: Map<string, AgentRuntimeMessage[]>,
  ) {}

  readonly reads: string[] = [];

  async listSessions(): Promise<readonly AgentSession[]> {
    return this.sessions;
  }

  async listRecentMessages(
    sessionId: string,
  ): Promise<readonly AgentRuntimeMessage[]> {
    this.reads.push(sessionId);
    return this.messages.get(sessionId) ?? [];
  }
}

function setup() {
  const source = new FakeSource(
    [
      session({ id: 'title-hit', title: '会话列表搜索', prompt: '实现搜索' }),
      session({
        id: 'content-hit',
        title: '无关标题',
        prompt: '无关提示',
        updatedAt: '2026-01-01T00:09:00.000Z',
      }),
      session({
        id: 'no-hit',
        title: '部署说明',
        prompt: '发布流程',
        updatedAt: '2026-01-01T00:08:00.000Z',
      }),
    ],
    new Map([
      [
        'content-hit',
        [
          message(
            'm1',
            'assistant',
            '搜索关键词高亮需要在会话列表里生效',
            '2026-01-01T00:00:01.000Z',
          ),
        ],
      ],
      [
        'no-hit',
        [message('m2', 'user', '无关正文', '2026-01-01T00:00:02.000Z')],
      ],
    ]),
  );
  const store = new MemorySessionSearchStore();
  const service = new SessionSearchService(source, store);
  return { source, store, service };
}

describe('SessionSearchService', () => {
  it('answers label hits immediately and content hits once indexing finishes', async () => {
    const { source, service } = setup();

    const first = await service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 20,
      offset: 0,
    });
    expect(first.items.map((item) => item.session.id)).toEqual(['title-hit']);
    expect(first.terms).toEqual(['搜索']);
    expect(first.indexing).toEqual({ ready: 0, pending: 3, total: 3 });

    await service.settle();
    const second = await service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 20,
      offset: 0,
    });
    expect(second.items.map((item) => item.session.id)).toEqual([
      'title-hit',
      'content-hit',
    ]);
    expect(second.indexing).toEqual({ ready: 3, pending: 0, total: 3 });
    // One read per session: typing again must not re-read indexed transcripts.
    expect(source.reads).toHaveLength(3);
  });

  it('serves every keystroke from memory instead of the history reader', async () => {
    const { source, service } = setup();
    await service.search({ projectId: 'p1', query: '搜索', limit: 20, offset: 0 });
    await service.settle();
    const readsAfterIndex = source.reads.length;
    for (const query of ['搜', '搜索', '搜索高', '搜索高亮', '高亮']) {
      await service.search({ projectId: 'p1', query, limit: 20, offset: 0 });
    }
    expect(source.reads).toHaveLength(readsAfterIndex);
  });

  it('reloads a persisted index without reading any transcript', async () => {
    const first = setup();
    await first.service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 20,
      offset: 0,
    });
    await first.service.settle();

    const warm = new FakeSource(first.source.sessions, first.source.messages);
    const service = new SessionSearchService(warm, first.store);
    const result = await service.search({
      projectId: 'p1',
      query: '高亮',
      limit: 20,
      offset: 0,
    });
    expect(result.items.map((item) => item.session.id)).toEqual(['content-hit']);
    expect(result.indexing).toEqual({ ready: 3, pending: 0, total: 3 });
    expect(warm.reads).toEqual([]);
  });

  it('reindexes a session that moved on and keeps answering from the old index meanwhile', async () => {
    const { source, service } = setup();
    await service.search({ projectId: 'p1', query: '搜索', limit: 20, offset: 0 });
    await service.settle();

    source.sessions = source.sessions.map((item) =>
      item.id === 'content-hit'
        ? { ...item, updatedAt: '2026-01-01T00:20:00.000Z' }
        : item,
    );
    source.messages.set('content-hit', [
      message(
        'm1',
        'assistant',
        '搜索关键词高亮需要在会话列表里生效',
        '2026-01-01T00:00:01.000Z',
      ),
      message('m3', 'user', '补充一条搜索说明', '2026-01-01T00:20:00.000Z'),
    ]);

    const stale = await service.search({
      projectId: 'p1',
      query: '高亮',
      limit: 20,
      offset: 0,
    });
    // The stale document still lists the session while the rebuild is queued.
    expect(stale.items.map((item) => item.session.id)).toEqual(['content-hit']);
    expect(stale.indexing.pending).toBe(1);

    await service.settle();
    const fresh = await service.search({
      projectId: 'p1',
      query: '补充',
      limit: 20,
      offset: 0,
    });
    expect(fresh.items.map((item) => item.session.id)).toEqual(['content-hit']);
    expect(fresh.indexing.pending).toBe(0);
  });

  it('does not re-read a streaming session on every keystroke', async () => {
    let now = 1_000;
    const source = new FakeSource(
      [
        session({
          id: 'live',
          title: '直播中的会话',
          prompt: '上下文',
          status: 'running',
          activeRunId: 'run-1',
        }),
      ],
      new Map([['live', []]]),
    );
    const service = new SessionSearchService(
      source,
      new MemorySessionSearchStore(),
      () => now,
    );
    await service.search({ projectId: 'p1', query: '直播', limit: 20, offset: 0 });
    await service.settle();
    expect(source.reads).toHaveLength(1);

    source.sessions = source.sessions.map((item) => ({
      ...item,
      updatedAt: '2026-01-01T00:11:00.000Z',
    }));
    now += 1_000;
    const throttled = await service.search({
      projectId: 'p1',
      query: '直播',
      limit: 20,
      offset: 0,
    });
    expect(throttled.indexing.pending).toBe(0);

    now += 60_000;
    const retried = await service.search({
      projectId: 'p1',
      query: '直播',
      limit: 20,
      offset: 0,
    });
    expect(retried.indexing.pending).toBe(1);
  });

  it('pages a hit list without dropping the ranking', async () => {
    const source = new FakeSource(
      Array.from({ length: 3 }, (_, index) =>
        session({
          id: `s${index}`,
          title: `搜索会话 ${index}`,
          prompt: '正文',
          updatedAt: `2026-01-01T00:0${3 - index}:00.000Z`,
        }),
      ),
      new Map(),
    );
    const service = new SessionSearchService(
      source,
      new MemorySessionSearchStore(),
    );
    const page = await service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 2,
      offset: 0,
    });
    expect(page.items.map((item) => item.session.id)).toEqual(['s0', 's1']);
    expect(page.hasMore).toBe(true);

    const rest = await service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 2,
      offset: 2,
    });
    expect(rest.items.map((item) => item.session.id)).toEqual(['s2']);
    expect(rest.hasMore).toBe(false);
  });

  it('ignores other workspaces, archived rows and sub-sessions', async () => {
    const source = new FakeSource(
      [
        session({ id: 'mine', title: '搜索目标' }),
        session({ id: 'other', title: '搜索目标', projectId: 'p2' }),
        session({
          id: 'archived',
          title: '搜索目标',
          sessionMetadata: { archivedAt: '2026-01-01T00:00:00.000Z' },
        } as never),
        session({ id: 'child', title: '搜索目标', parentSessionId: 'mine' }),
      ],
      new Map(),
    );
    const service = new SessionSearchService(
      source,
      new MemorySessionSearchStore(),
    );
    const result = await service.search({
      projectId: 'p1',
      query: '搜索',
      limit: 20,
      offset: 0,
    });
    expect(result.items.map((item) => item.session.id)).toEqual(['mine']);
    expect(result.indexing.total).toBe(1);
  });

  it('skips the whole pipeline for a blank query', async () => {
    const { source, service } = setup();
    const result = await service.search({
      projectId: 'p1',
      query: '   ',
      limit: 20,
      offset: 0,
    });
    expect(result.items).toEqual([]);
    expect(result.terms).toEqual([]);
    expect(source.reads).toEqual([]);
  });
});

describe('boundDocuments', () => {
  it('keeps the newest conversations inside the stored document budget', () => {
    const documents = Array.from({ length: MAX_STORED_DOCUMENTS + 5 }, (_, index) =>
      buildSessionSearchDocument(
        session({
          id: `s${index}`,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        }),
        [],
      ),
    );
    const bounded = boundDocuments(documents);
    expect(bounded).toHaveLength(MAX_STORED_DOCUMENTS);
    expect(bounded[0].sessionId).toBe(`s${MAX_STORED_DOCUMENTS + 4}`);
  });
});
