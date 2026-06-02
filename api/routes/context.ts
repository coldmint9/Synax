// ---------------------------------------------------------------------------
// api/routes/context.ts — 上下文管理系统路由
//
// 职责：
//   - Session / Entry / Snapshot / Memory / Link 的 REST 端点
//   - /search 全文搜索（Phase 2 接入 SearchService）
//   - /sync SSE 实时推送（Phase 5 接入 SyncBus，当前 Phase 1 提供占位端点）
//   - /suggest, /compress, /export, /import 等端点将在后续阶段填充实现
//
// 约定：全量 Zod safeParse 校验，projectId 在路由层强制非空。
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import { contextService } from '../services/context/context-service.js';
import { compressionService } from '../services/context/compression-service.js';
import { memoryManager } from '../services/context/memory-manager.js';
import { searchService } from '../services/context/search-service.js';
import { sessionManager } from '../services/context/session-manager.js';
import { syncBus } from '../services/context/sync-bus.js';
import { SseEventType } from '../lib/sse-events.js';
import type { SyncEvent } from '../services/contracts/context.js';

export const contextRoutes = new Hono();

// ============================== Zod schemas ==============================

const projectIdField = z.string().min(1).max(128);
const idField = z.string().min(1).max(64);

const createSessionSchema = z.object({
  projectId: projectIdField,
  userId: z.string().min(1).max(128),
  title: z.string().max(200).optional(),
  sourceAgent: z.string().max(64).optional(),
  ttlHours: z.number().int().positive().max(24 * 30).optional(),
});

const sessionListQuerySchema = z.object({
  projectId: projectIdField,
  status: z.enum(['active', 'archived', 'expired']).optional(),
  userId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  summary: z.string().max(10_000).nullable().optional(),
  status: z.enum(['active', 'archived', 'expired']).optional(),
});

const appendEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(100_000),
  contentType: z
    .enum(['text', 'code', 'tool_call', 'tool_result', 'markdown'])
    .default('text'),
  tokenEstimate: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
  parentEntryId: z.string().optional(),
});

const entryListQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  afterSequence: z.coerce.number().int().min(0).optional(),
});

const updateEntrySchema = z.object({
  content: z.string().max(100_000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createSnapshotSchema = z.object({
  label: z.string().max(200).optional(),
  fromSequence: z.number().int().nonnegative().optional(),
  toSequence: z.number().int().nonnegative().optional(),
  compressedContent: z.string().max(200_000).optional(),
  diffBaseId: z.string().optional(),
  createdBy: z.string().max(128).optional(),
});

const createMemorySchema = z.object({
  projectId: projectIdField,
  memoryType: z.enum(['pattern', 'decision', 'preference', 'convention', 'insight', 'risk']),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  sourceSessionId: z.string().nullable().optional(),
  sourceEntryId: z.string().nullable().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  confidence: z.number().min(0).max(1).optional(),
  references: z
    .object({
      nodeIds: z.array(z.string()).optional(),
      filePaths: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  expiresAt: z.string().nullable().optional(),
});

const memoryListQuerySchema = z.object({
  projectId: projectIdField,
  memoryType: z
    .enum(['pattern', 'decision', 'preference', 'convention', 'insight', 'risk'])
    .optional(),
  status: z.enum(['active', 'archived', 'superseded']).optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const updateMemorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20_000).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['active', 'archived', 'superseded']).optional(),
  memoryType: z
    .enum(['pattern', 'decision', 'preference', 'convention', 'insight', 'risk'])
    .optional(),
  references: z.record(z.unknown()).optional(),
});

const createLinkSchema = z.object({
  projectId: projectIdField,
  entryId: idField,
  nodeId: idField,
  linkType: z.enum(['mentions', 'discusses', 'creates', 'modifies', 'references', 'resolves']),
  confidence: z.number().min(0).max(1).optional(),
});

const searchSchema = z.object({
  projectId: projectIdField,
  query: z.string().min(1).max(500),
  scope: z.enum(['entries', 'memories', 'all']).default('all'),
  limit: z.number().int().min(1).max(100).default(20),
  role: z.enum(['user', 'assistant', 'system', 'tool']).optional(),
  memoryType: z
    .enum(['pattern', 'decision', 'preference', 'convention', 'insight', 'risk'])
    .optional(),
  sessionId: z.string().optional(),
});

const suggestSchema = z.object({
  projectId: projectIdField,
  partialIntent: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});

const resumeSessionSchema = z.object({
  projectId: projectIdField,
  userId: z.string().min(1),
  sourceAgent: z.string().max(64).optional(),
});

// ============================== helpers ==============================

async function parseJsonBody(c: Context) {
  try {
    return { ok: true as const, data: await c.req.json() };
  } catch {
    return { ok: false as const, error: 'Invalid JSON body' };
  }
}

function validationError(c: Context, parsed: { error: z.ZodError }) {
  return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
}

// ============================== Session ==============================

contextRoutes.get('/sessions', (c) => {
  const parsed = sessionListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed);
  const { projectId, ...filter } = parsed.data;
  const result = contextService.listSessions(projectId, filter);
  return c.json(result);
});

contextRoutes.post('/sessions', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = createSessionSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const { projectId, userId, ...opts } = parsed.data;
  const session = contextService.createSession(projectId, userId, opts);
  return c.json(session, 201);
});

// POST /sessions/resume — 复用同项目/用户/来源的活跃会话，否则新建
contextRoutes.post('/sessions/resume', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = resumeSessionSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const session = sessionManager.createOrResumeSession(
    parsed.data.projectId,
    parsed.data.userId,
    parsed.data.sourceAgent,
  );
  return c.json(session);
});

contextRoutes.get('/sessions/:id', (c) => {
  const s = contextService.getSession(c.req.param('id'));
  return s ? c.json(s) : c.json({ error: 'not found' }, 404);
});

contextRoutes.patch('/sessions/:id', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = updateSessionSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const updated = contextService.updateSession(c.req.param('id'), parsed.data);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

contextRoutes.delete('/sessions/:id', (c) => {
  const hard = c.req.query('hard') === '1';
  try {
    if (hard) {
      contextService.deleteSession(c.req.param('id'));
      return c.json({ ok: true, deleted: true });
    }
    const s = contextService.archiveSession(c.req.param('id'));
    return c.json(s);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

// ============================== Entry ==============================

contextRoutes.get('/sessions/:id/entries', (c) => {
  const parsed = entryListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed);
  const result = contextService.getEntries(c.req.param('id'), parsed.data);
  return c.json(result);
});

contextRoutes.post('/sessions/:id/entries', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = appendEntrySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const entry = contextService.appendEntry(c.req.param('id'), parsed.data);
    // 追加后触发 token 预警检查（内部异步发 SSE，不阻塞响应）
    sessionManager.checkTokenWarning(c.req.param('id'));
    return c.json(entry, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

contextRoutes.get('/sessions/:sid/entries/:eid', (c) => {
  const entry = contextService.getEntry(c.req.param('eid'));
  if (!entry || entry.sessionId !== c.req.param('sid')) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json(entry);
});

// 轻量 by-id 读取（供 NodeDetailPanel Context Links 展示使用）
contextRoutes.get('/entries/:eid', (c) => {
  const entry = contextService.getEntry(c.req.param('eid'));
  return entry ? c.json(entry) : c.json({ error: 'not found' }, 404);
});

contextRoutes.patch('/sessions/:sid/entries/:eid', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = updateEntrySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const updated = contextService.updateEntry(c.req.param('eid'), parsed.data);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

contextRoutes.delete('/sessions/:sid/entries/:eid', (c) => {
  contextService.deleteEntry(c.req.param('eid'));
  return c.json({ ok: true });
});

// ============================== Snapshot ==============================

contextRoutes.get('/sessions/:id/snapshots', (c) => {
  const snaps = contextService.getSnapshots(c.req.param('id'));
  return c.json({ items: snaps });
});

contextRoutes.post('/sessions/:id/snapshots', async (c) => {
  const body = await parseJsonBody(c);
  const parsed = createSnapshotSchema.safeParse(body.ok ? body.data : {});
  if (!parsed.success) return validationError(c, parsed);
  try {
    const snap = contextService.createSnapshot(c.req.param('id'), parsed.data);
    return c.json(snap, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

contextRoutes.get('/sessions/:id/snapshots/:sid', (c) => {
  const snap = contextService.getSnapshot(c.req.param('sid'));
  return snap ? c.json(snap) : c.json({ error: 'not found' }, 404);
});

// 恢复快照（Phase 3 填充真正逻辑；Phase 1 暂返回占位响应）
contextRoutes.post('/sessions/:id/snapshots/:sid/restore', (c) => {
  return c.json({ ok: false, message: 'restore snapshot: not implemented in Phase 1' }, 501);
});

// ============================== Memory ==============================

contextRoutes.get('/memories', (c) => {
  const parsed = memoryListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return validationError(c, parsed);
  const { projectId, ...filter } = parsed.data;
  const result = contextService.listMemories(projectId, filter);
  return c.json(result);
});

contextRoutes.post('/memories', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = createMemorySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const { projectId, ...rest } = parsed.data;
  const mem = contextService.createMemory(projectId, rest);
  return c.json(mem, 201);
});

contextRoutes.get('/memories/:id', (c) => {
  const m = contextService.getMemory(c.req.param('id'));
  return m ? c.json(m) : c.json({ error: 'not found' }, 404);
});

contextRoutes.patch('/memories/:id', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = updateMemorySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const updated = contextService.updateMemory(c.req.param('id'), parsed.data);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

contextRoutes.delete('/memories/:id', (c) => {
  contextService.deleteMemory(c.req.param('id'));
  return c.json({ ok: true });
});

// ============================== Link ==============================

contextRoutes.post('/links', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = createLinkSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const link = contextService.createLink(parsed.data);
  return c.json(link, 201);
});

contextRoutes.get('/links', (c) => {
  const url = new URL(c.req.url);
  const nodeId = url.searchParams.get('nodeId');
  const entryId = url.searchParams.get('entryId');
  const projectId = url.searchParams.get('projectId');
  if (nodeId) {
    if (!projectId) return c.json({ error: 'projectId required for nodeId query' }, 400);
    return c.json({ items: contextService.getLinksByNode(projectId, nodeId) });
  }
  if (entryId) {
    return c.json({ items: contextService.getLinksByEntry(entryId) });
  }
  return c.json({ error: 'nodeId or entryId required' }, 400);
});

contextRoutes.delete('/links/:id', (c) => {
  contextService.deleteLink(c.req.param('id'));
  return c.json({ ok: true });
});

// ============================== 占位端点（后续阶段填充） ==============================

contextRoutes.post('/search', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = searchSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const { projectId, query, scope, ...rest } = parsed.data;
  const hits =
    scope === 'entries'
      ? searchService.searchEntries(projectId, query, rest)
      : scope === 'memories'
      ? searchService.searchMemories(projectId, query, rest)
      : searchService.searchAll(projectId, query, rest);
  searchService.touchHits(hits);
  return c.json({ items: hits });
});

contextRoutes.post('/suggest', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = suggestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const items = searchService.suggest(
    parsed.data.projectId,
    parsed.data.partialIntent,
    parsed.data.limit,
  );
  return c.json({ items });
});

contextRoutes.get('/suggestions', (c) => {
  const url = new URL(c.req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  const nodeId = url.searchParams.get('nodeId');
  const runId = url.searchParams.get('runId');
  const limit = Number(url.searchParams.get('limit') ?? '8');
  try {
    const items = contextService.suggestContextBlocks({
      projectId,
      nodeId,
      runId,
      limit,
    });
    return c.json({ items });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
contextRoutes.post('/compress', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({
      sessionId: idField,
      recentN: z.number().int().min(1).max(200).optional(),
      tokenThreshold: z.number().int().min(512).max(1_000_000).optional(),
      mode: z.enum(['auto', 'force']).default('auto'),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const result =
      parsed.data.mode === 'force'
        ? await compressionService.buildSlidingWindow(
            parsed.data.sessionId,
            parsed.data.recentN,
          )
        : await compressionService.maybeCompress(
            parsed.data.sessionId,
            parsed.data.tokenThreshold,
          );
    return c.json({ ok: true, result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /memories/extract — 从会话提取长期记忆
contextRoutes.post('/memories/extract', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z.object({ sessionId: idField }).safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    const memories = await memoryManager.extractMemories(parsed.data.sessionId);
    return c.json({ items: memories });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /memories/relevant — 为 analyzer / context 流程返回相关长期记忆
contextRoutes.post('/memories/relevant', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({
      projectId: projectIdField,
      currentContext: z.string().min(1).max(5000),
      topK: z.number().int().min(1).max(20).default(5),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const mems = memoryManager.getRelevantMemories(
    parsed.data.projectId,
    parsed.data.currentContext,
    parsed.data.topK,
  );
  return c.json({ items: mems });
});
contextRoutes.post('/export', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z.object({ projectId: projectIdField }).safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  const payload = contextService.exportProject(parsed.data.projectId);
  return c.json(payload);
});

contextRoutes.post('/import', async (c) => {
  const body = await parseJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = z
    .object({
      projectId: projectIdField,
      strategy: z.enum(['replace', 'merge']).default('merge'),
      data: z
        .object({
          projectId: z.string(),
          exportedAt: z.string().optional(),
          sessions: z.array(z.any()).default([]),
          entries: z.array(z.any()).default([]),
          snapshots: z.array(z.any()).default([]),
          memories: z.array(z.any()).default([]),
          links: z.array(z.any()).default([]),
        })
        .passthrough(),
    })
    .safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed);
  try {
    // 只信任 routes 层传入的 projectId，强制覆盖 data.projectId
    const normalized = { ...parsed.data.data, projectId: parsed.data.projectId };
    const result = contextService.importProject(
      parsed.data.projectId,
      normalized as unknown as Parameters<typeof contextService.importProject>[1],
      parsed.data.strategy,
    );
    return c.json({ ok: true, result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ============================== SSE 同步 ==============================

contextRoutes.get('/sync', (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);

  return streamSSE(c, async (stream) => {
    let closed = false;
    const onEvent = (event: SyncEvent) => {
      if (closed) return;
      stream
        .writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(event.timestamp),
        })
        .catch(() => {
          closed = true;
        });
    };
    const unsubscribe = syncBus.subscribe(projectId, onEvent);

    // 初次握手
    await stream.writeSSE({ event: SseEventType.Ready, data: JSON.stringify({ projectId }) });

    // 心跳（每 25s）防止代理断连
    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: SseEventType.Ping, data: String(Date.now()) }).catch(() => {
        closed = true;
      });
    }, 25_000);

    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    // keep stream open
    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});
