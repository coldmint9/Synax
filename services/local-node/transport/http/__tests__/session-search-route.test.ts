import { rm } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentSessionRuntime } from '../../../modules/agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../../../modules/agent-runtime/session-store.js';
import { sessionSearchService } from '../../../modules/agent-runtime/session-query/search-service.js';
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { DATA_ROOT } from '../../../infrastructure/runtime/env.js';

async function createSession(prompt: string, replies: string[]) {
  const session = agentSessionRuntime.create({ ...executorInput, prompt });
  replies.forEach((content, index) => {
    agentRuntimeStore.appendMessage({
      id: `${session.id}-${index}`,
      sessionId: session.id,
      runId: null,
      stepId: null,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
  });
  await agentRuntimeStore.flushSession(session.id);
  return session;
}

async function search(q: string) {
  const response = await agentRuntimeRoutes.request(
    `http://localhost/sessions/search?projectId=project-alpha&limit=20&offset=0&q=${encodeURIComponent(q)}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: Array<{
      session: { id: string; title: string | null };
      snippet: string;
      kind: string;
      matchCount: number;
    }>;
    hasMore: boolean;
    terms: string[];
    indexing: { ready: number; pending: number; total: number };
  };
}

beforeEach(async () => {
  await sessionSearchService.settle();
  sessionSearchService.reset();
  await rm(path.join(DATA_ROOT, 'session-search'), {
    recursive: true,
    force: true,
  });
  await resetAgentRuntimeFixtures();
});

it('answers keywords from the persisted index instead of reading history per keystroke', async () => {
  const titled = await createSession('帮我排查构建失败', []);
  agentRuntimeStore.updateSession(titled.id, { title: '构建失败排查' });
  await agentRuntimeStore.flushSession(titled.id);
  const chatty = await createSession('随便聊聊', [
    '先看看日志',
    '关键词高亮要在会话列表里展示',
  ]);

  const cold = await search('关键词高亮');
  expect(cold.terms).toEqual(['关键词高亮']);
  expect(cold.indexing.total).toBe(2);
  expect(cold.items.some((item) => item.session.id === chatty.id)).toBe(false);

  await sessionSearchService.settle();

  const warm = await search('关键词高亮');
  expect(warm.indexing).toEqual({ ready: 2, pending: 0, total: 2 });
  expect(warm.items.map((item) => item.session.id)).toEqual([chatty.id]);
  expect(warm.items[0]).toMatchObject({ kind: 'message' });
  expect(warm.items[0].snippet).toContain('关键词高亮');
  expect(warm.items[0].matchCount).toBe(1);
});

it('matches the session label first and highlights every keyword', async () => {
  await createSession('无关正文', []);
  const labeled = await createSession('整理发布流程', []);
  agentRuntimeStore.updateSession(labeled.id, { title: '发布流程与回滚' });
  await agentRuntimeStore.flushSession(labeled.id);

  const result = await search('发布 回滚');
  expect(result.items.map((item) => item.session.id)).toEqual([labeled.id]);
  expect(result.items[0]).toMatchObject({ kind: 'title' });
  expect(result.terms).toEqual(['发布', '回滚']);
});

it('rejects an empty keyword instead of scanning the workspace', async () => {
  const response = await agentRuntimeRoutes.request(
    'http://localhost/sessions/search?projectId=project-alpha&q=',
  );
  expect(response.status).toBe(400);
});

it('never resolves the search endpoint as a session resource', async () => {
  const response = await agentRuntimeRoutes.request(
    'http://localhost/sessions/search?projectId=project-alpha&q=hello',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [], hasMore: false });
});
