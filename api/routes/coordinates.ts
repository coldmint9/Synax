import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import { createAcpClient, createAcpClientForProject } from '../services/acp/index.js';
import type { DispatchIntentInput } from '../services/acp/contracts.js';
import {
  spawnAcpConnection,
  initializeSession,
  resolveSpawnForProvider,
} from '../services/acp/protocol/acp-connection.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  fetchForest,
  scanCodeMap as analyzerScanCodeMap,
  search as analyzerSearch,
  suggestMount as analyzerSuggestMount,
} from '../services/analyzer-client.js';
import { proxyUpstreamSSE } from '../lib/sse-proxy.js';
import { getEffectiveConfig } from '../lib/config/config-store.js';
import { logger } from '../lib/logger.js';
import { contextService } from '../services/context/context-service.js';
import { AgentLoopCollector } from '../services/context/agent-loop-collector.js';
import { synapseContextAgentService } from '../services/context/synapse-context-agent-service.js';
import type { CoordForest } from '../services/contracts/forest.js';

/** Coordinates 子路由 */
export const coordinatesRoutes = new Hono();

/** 健康检查 */
coordinatesRoutes.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// --- v3 CoordForest 初始化 / 检索 / 语义建议 路由 ---

const sourceBindingSchema = z.object({
  kind: z.enum(['git', 'localPath', 'scratch']),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  localPath: z.string().optional(),
  lastSyncedAt: z.number().optional(),
});

const initAnalyzeSchema = z.object({
  projectId: z.string().min(1),
  source: sourceBindingSchema,
  // UI-selected locale; forwarded to analyzer so seed-agent emits labels/summary
  // in the user's chosen language. Defaults to zh for backward compatibility.
  locale: z.enum(['zh', 'en']).optional().default('zh'),
});

const searchSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1),
  mode: z.enum(['keyword', 'hybrid']).optional(),
  topK: z.number().int().positive().max(200).optional(),
  alpha: z.number().min(0).max(1).optional(),
});

const suggestMountSchema = z.object({
  projectId: z.string().min(1),
  intent: z.string().min(1),
});

const codeMapScanSchema = z.object({
  projectId: z.string().min(1),
  source: sourceBindingSchema.optional(),
  workDir: z.string().min(1).optional(),
  include: z
    .array(z.enum(['all', 'module-map', 'communities', 'coord-seed']))
    .optional(),
  limits: z
    .object({
      maxCommunities: z.number().int().min(1).max(300).optional(),
      maxEntryFiles: z.number().int().min(1).max(200).optional(),
      maxCoreSymbols: z.number().int().min(1).max(300).optional(),
      maxDependencies: z.number().int().min(1).max(500).optional(),
      maxActionsPerCommunity: z.number().int().min(1).max(12).optional(),
      evidencePerFeature: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  actorId: z.string().nullable().optional(),
}).refine((value) => Boolean(value.source || value.workDir), {
  message: 'source or workDir is required',
  path: ['workDir'],
});

const reanalyzeSchema = z.object({
  projectId: z.string().min(1),
  source: sourceBindingSchema.optional(),
  locale: z.enum(['zh', 'en']).optional().default('zh'),
});

const reviewGoalSchema = z.object({
  projectId: z.string().min(1),
  goalId: z.string().min(1),
  forest: z.record(z.unknown()),
  contextIndex: z.record(z.unknown()).optional(),
  workDir: z.string().nullable().optional(),
  locale: z.enum(['zh', 'en']).optional().default('zh'),
});

const saveStateSchema = z.object({
  forest: z.record(z.unknown()),
  actorId: z.string().nullable().optional(),
});

const contextBindingSchema = z.object({
  projectId: z.string().min(1).optional(),
  blockId: z.string().min(1),
  relation: z
    .enum([
      'uses',
      'references',
      'constrains',
      'resolves',
      'produces',
      'contains',
      'mentions',
      'discusses',
      'creates',
      'modifies',
    ])
    .default('references'),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdBy: z.string().nullable().optional(),
});

const runVerdictSchema = z.object({
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
  verdict: z.enum(['accepted', 'rejected']),
  note: z.string().optional(),
  reasons: z.array(z.string()).optional(),
  actorId: z.string().nullable().optional(),
});

const suggestionDecisionSchema = z.object({
  projectId: z.string().min(1),
  actorId: z.string().nullable().optional(),
});

const shareSignalSchema = z.object({
  projectId: z.string().min(1),
  targetNodeId: z.string().min(1).nullable().optional(),
  actorId: z.string().nullable().optional(),
});


coordinatesRoutes.post('/init/analyze', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = initAnalyzeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  logger.info({ projectId: input.projectId }, '[coordinates] init/analyze start');
  return proxyUpstreamSSE(c, '/analyze', input, {
    scope: 'coordinates.init/analyze',
    logContext: { projectId: input.projectId },
    llmPurpose: 'analyze',
  });
});

/**
 * POST /reanalyze — 增量重算，analyzer 端走 chunk-hash 缓存。
 */
coordinatesRoutes.post('/reanalyze', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = reanalyzeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const { projectId, source, locale } = parsed.data;
  if (!source) {
    return c.json({ error: 'source is required for reanalyze' }, 400);
  }
  return proxyUpstreamSSE(
    c,
    '/reanalyze',
    { projectId, source, locale },
    { scope: 'coordinates.reanalyze', logContext: { projectId }, llmPurpose: 'reanalyze' },
  );
});

/** POST /search — 代理 analyzer /search/{mode}。 */
coordinatesRoutes.post('/search', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await analyzerSearch(parsed.data);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '[coordinates] search failed');
    return c.json({ error: message }, 502);
  }
});

/** POST /semantic/suggest — 候选挂载点。 */
coordinatesRoutes.post('/semantic/suggest', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = suggestMountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await analyzerSuggestMount(parsed.data);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '[coordinates] suggestMount failed');
    return c.json({ error: message }, 502);
  }
});

/** POST /code-map/scan — fast tree-setter scan proxy. */
coordinatesRoutes.post('/code-map/scan', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = codeMapScanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const { actorId, ...scanInput } = parsed.data;
  try {
    const result = await analyzerScanCodeMap(scanInput);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '[coordinates] code-map scan failed');
    return c.json({ error: message }, 502);
  }
});

/** GET /forest/:projectId — 拉取最新 forest 快照（空返回 null）。 */
coordinatesRoutes.get('/forest/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  if (!projectId) return c.json({ error: 'missing projectId' }, 400);
  try {
    const forest = await fetchForest(projectId);
    if (!forest) return c.json(null);
    return c.json(forest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId }, '[coordinates] fetchForest failed');
    return c.json({ error: message }, 502);
  }
});

coordinatesRoutes.get('/:projectId/state', async (c) => {
  const projectId = c.req.param('projectId');
  if (!projectId) return c.json({ error: 'missing projectId' }, 400);
  try {
    const local = contextService.getCoordinatesState(projectId);
    const remote = await fetchForest(projectId).catch(() => null);
    const forest = local?.forest ?? remote ?? null;
    const revision = local?.revision ?? forest?.revision ?? 0;
    const contextIndex = contextService.getCoordinatesContextIndex(projectId);
    return c.json({
      forest,
      revision,
      eventHeadRevision: contextIndex.headRevision,
      context: contextIndex,
      updatedAt: local?.updatedAt ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId }, '[coordinates] get state failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.put('/:projectId/state', async (c) => {
  const projectId = c.req.param('projectId');
  if (!projectId) return c.json({ error: 'missing projectId' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = saveStateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = contextService.saveCoordinatesState(
      projectId,
      parsed.data.forest as unknown as CoordForest,
      parsed.data.actorId ?? null,
    );
    return c.json({
      forest: result.forest,
      revision: result.revision,
      event: result.event,
      updatedAt: result.updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId }, '[coordinates] save state failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.get('/events', (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  const afterRevision = Number(c.req.query('afterRevision') ?? '0');
  const limit = Number(c.req.query('limit') ?? '200');
  try {
    const items = contextService.getCoordEvents(projectId, afterRevision, limit);
    return c.json({ items, headRevision: contextService.getHeadRevision(projectId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId }, '[coordinates] get events failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.get('/runs/:runId/loop', (c) => {
  const runId = c.req.param('runId');
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  try {
    const loop = contextService.getAgentLoopByRunId(projectId, runId);
    if (!loop) return c.json({ error: 'loop not found' }, 404);
    return c.json(loop);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId, runId }, '[coordinates] get run loop failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.get('/nodes/:nodeId/loops', (c) => {
  const nodeId = c.req.param('nodeId');
  const projectId = c.req.query('projectId');
  const limit = Number(c.req.query('limit') ?? '20');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  try {
    const items = contextService.listAgentLoopsByNode(projectId, nodeId, limit);
    return c.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId, nodeId }, '[coordinates] list node loops failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.get('/nodes/:nodeId/synapse-context', (c) => {
  const nodeId = c.req.param('nodeId');
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  try {
    const context = contextService.getSynapseContextForNode(projectId, nodeId);
    return c.json(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId, nodeId }, '[coordinates] get synapse context failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.post('/context-suggestions/:id/accept', async (c) => {
  const suggestionId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = suggestionDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const suggestion = contextService.acceptDisclosureSuggestion(suggestionId, parsed.data.actorId ?? 'web');
    if (suggestion.projectId !== parsed.data.projectId) return c.json({ error: 'project mismatch' }, 409);
    return c.json(suggestion);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, suggestionId }, '[coordinates] accept context suggestion failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.post('/context-suggestions/:id/dismiss', async (c) => {
  const suggestionId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = suggestionDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const suggestion = contextService.dismissDisclosureSuggestion(suggestionId, parsed.data.actorId ?? 'web');
    if (suggestion.projectId !== parsed.data.projectId) return c.json({ error: 'project mismatch' }, 409);
    return c.json(suggestion);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, suggestionId }, '[coordinates] dismiss context suggestion failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.post('/context-signals/:id/share', async (c) => {
  const signalId = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = shareSignalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const suggestions = contextService.shareContextSignal({
      projectId: parsed.data.projectId,
      signalId,
      targetNodeId: parsed.data.targetNodeId ?? null,
      actorId: parsed.data.actorId ?? 'web',
    });
    return c.json({ items: suggestions }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, signalId }, '[coordinates] share context signal failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.post('/nodes/:nodeId/context-bindings', async (c) => {
  const nodeId = c.req.param('nodeId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = contextBindingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const projectId = parsed.data.projectId;
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  try {
    const binding = contextService.createContextBinding({
      projectId,
      blockId: parsed.data.blockId,
      targetKind: 'node',
      targetId: nodeId,
      relation: parsed.data.relation,
      confidence: parsed.data.confidence,
      metadata: parsed.data.metadata,
      createdBy: parsed.data.createdBy ?? null,
    });
    return c.json(binding, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, projectId, nodeId }, '[coordinates] create context binding failed');
    return c.json({ error: message }, 500);
  }
});

coordinatesRoutes.post('/runs/:runId/verdict', async (c) => {
  const runId = c.req.param('runId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = runVerdictSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const block = contextService.recordRunVerdict({
      projectId: parsed.data.projectId,
      nodeId: parsed.data.nodeId,
      runId,
      verdict: parsed.data.verdict,
      note: parsed.data.note,
      reasons: parsed.data.reasons,
      actorId: parsed.data.actorId ?? 'web',
    });
    return c.json({ block }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, runId }, '[coordinates] record run verdict failed');
    return c.json({ error: message }, 500);
  }
});

/**
 * POST /review/goal/stream — 代理 analyzer /review/goal。
 *
 * 请求必须携带前端当前 forest 快照；当前 Coordinates 的最新人工编辑和
 * action run 状态主要保存在浏览器 localStorage，而 analyzer 的
 * meta_store 可能不是最新状态。
 */
coordinatesRoutes.post('/review/goal/stream', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = reviewGoalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const source = parsed.data.forest.source as { kind?: unknown; localPath?: unknown } | undefined;
  const workDir =
    parsed.data.workDir ??
    (source?.kind === 'localPath' && typeof source.localPath === 'string' ? source.localPath : null);
  const payload = {
    ...parsed.data,
    contextIndex: parsed.data.contextIndex ?? contextService.getCoordinatesContextIndex(parsed.data.projectId),
    workDir,
  };
  return proxyUpstreamSSE(
    c,
    '/review/goal',
    payload,
    {
      scope: 'coordinates.review/goal',
      logContext: { projectId: payload.projectId, goalId: payload.goalId },
      llmPurpose: 'review',
    },
  );
});

// --- _internal: ACP text-generation bridge for local agent runtime calls ---

const acpGenerateSchema = z.object({
  projectId: z.string().optional(),
  providerId: z.enum(['opencode-acp', 'cursor-acp']).optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Absolute path to the target project's local working directory. The ACP
  // session's cwd is anchored here so the remote Cursor agent's filesystem
  // view points at the analyzed repo — NOT the Synapse host process cwd.
  // Missing/empty means "caller forgot to pass it" and the Node side logs a
  // warning + falls back to ``process.cwd()``.
  workDir: z.string().optional(),
});

/** Timeout for the entire ACP generate cycle. */
const ACP_GENERATE_TIMEOUT_MS = 30 * 60_000;

/**
 * POST /_internal/acp-generate — SSE bridge for local ACP tooling.
 *
 * The agent runtime calls this endpoint to proxy chat completions through the
 * configured local ACP CLI. Streams text deltas as `data: {"delta":"..."}` SSE events.
 */
coordinatesRoutes.post('/_internal/acp-generate', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = acpGenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const { messages, projectId, workDir } = parsed.data;
  const configuredProviderId = projectId ? getEffectiveConfig(projectId).providerId : null;
  const providerId = parsed.data.providerId
    ?? (configuredProviderId === 'cursor-acp' || configuredProviderId === 'opencode-acp'
      ? configuredProviderId
      : 'opencode-acp');

  // Build a single prompt string from the chat messages
  const promptText = messages
    .map((m) => (m.role === 'system' ? `[System] ${m.content}` : m.content))
    .join('\n\n');

  logger.info(
    { providerId, promptLength: promptText.length, messageCount: messages.length, workDir: workDir ?? null },
    '[acp-generate] request received',
  );

  return streamSSE(c, async (stream) => {
    let acpConn: ReturnType<typeof spawnAcpConnection> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    stream.onAbort(() => {
      logger.info('[acp-generate] client aborted');
      acpConn?.cleanup();
    });

    try {
      acpConn = spawnAcpConnection({
        async sessionUpdate(params: SessionNotification) {
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk') {
            const content = update.content;
            let text = '';
            if (content && typeof content === 'object' && 'type' in content) {
              if (content.type === 'text' && 'text' in content) {
                text = (content as { text: string }).text;
              }
            }
            if (text) {
              await stream.writeSSE({ data: JSON.stringify({ delta: text }) });
            }
          }
        },
      }, resolveSpawnForProvider(providerId));

      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        acpConn!.child.once('error', (err) => reject(err));
        acpConn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              new Error(
                `${acpConn!.spawn.commandLabel} exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
              ),
            );
          }
        });
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('ACP generate timed out')),
          ACP_GENERATE_TIMEOUT_MS,
        );
      });

      const protocolFlow = async (): Promise<void> => {
        const sessionId = await initializeSession(acpConn!.conn, workDir);
        await acpConn!.conn.prompt({
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        });
      };

      await Promise.race([protocolFlow(), timeoutPromise, spawnErrorPromise]);

      await stream.writeSSE({ data: '[DONE]' });
      logger.info('[acp-generate] completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = acpConn?.stderrChunks.join('') ?? '';
      logger.error({ err: message, stderr }, '[acp-generate] failed');
      await stream.writeSSE({
        data: JSON.stringify({ error: message }),
      });
      await stream.writeSSE({ data: '[DONE]' });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      acpConn?.cleanup();
    }
  });
});

// --- Zod schema for dispatch input ---
const dispatchSchema = z.object({
  projectId: z.string(),
  sessionId: z.string().nullable().optional(),
  userId: z.string(),
  userName: z.string(),
  intent: z.string().min(1),
  providerId: z.enum(['opencode-acp', 'cursor-acp']),
  context: z.object({
    selectedNodeId: z.string().nullable().optional(),
    selectedClusterId: z.string().nullable().optional(),
    workDir: z.string().nullable().optional(),
    contextSnapshotId: z.string().nullable().optional(),
    contextPrompt: z.string().nullable().optional(),
  }).optional(),
});

/**
 * POST /dispatch/stream — SSE 流式端点
 * 实时推送 ACP 事件到前端，事件产生时立即发送，无需等待全部完成。
 * 适合 live 模式和 mock 模式的渐进式 UI 更新。
 */
coordinatesRoutes.post('/dispatch/stream', async (c) => {
  logger.info({ path: '/dispatch/stream' }, 'Stream dispatch request received');

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten() }, 'Stream dispatch validation failed');
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input: DispatchIntentInput = parsed.data;
  logger.info({ projectId: input.projectId, intent: input.intent }, 'Stream dispatch starting');

  const acpClient = await createAcpClientForProject(input.projectId);
  let contextSnapshotId = input.context?.contextSnapshotId ?? null;
  let contextPrompt = input.context?.contextPrompt ?? null;
  if (input.context?.selectedNodeId && (!contextSnapshotId || !contextPrompt)) {
    const provisionalRunId = `srv_${Date.now().toString(36)}`;
    const snapshot = contextService.createRunSnapshot({
      projectId: input.projectId,
      nodeId: input.context.selectedNodeId,
      runId: provisionalRunId,
      prompt: input.intent,
      createdBy: input.userId,
    });
    contextSnapshotId = snapshot.id;
    contextPrompt = snapshot.frozenContext
      .map((item, idx) => `${idx + 1}. [${item.kind}] ${item.title}\n${item.content}`)
      .join('\n\n');
    input.context = {
      ...input.context,
      contextSnapshotId,
      contextPrompt,
    };
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      logger.info({ projectId: input.projectId }, '[StreamSSE] client disconnected')
    })

    let collector: AgentLoopCollector | null = null
    let currentRunId: string | null = null
    try {
      let eventCount = 0
      for await (const event of acpClient.dispatchStream(input)) {
        if (input.context?.selectedNodeId) {
          const nodeId = input.context.selectedNodeId;
          const runId = event.runId || input.context.contextSnapshotId || 'unknown-run';
          if (event.type === 'run_started') {
            currentRunId = runId
            if (contextSnapshotId) {
              contextService.attachRunSnapshotToRun(contextSnapshotId, runId);
            } else {
              const snapshot = contextService.createRunSnapshot({
                projectId: input.projectId,
                nodeId,
                runId,
                prompt: input.intent,
                createdBy: input.userId,
              });
              contextSnapshotId = snapshot.id;
            }
            event.payload = {
              ...(event.payload ?? {}),
              contextSnapshotId,
            };
            collector = new AgentLoopCollector({
              projectId: input.projectId,
              nodeId,
              runId,
              provider:
                typeof event.payload?.provider === 'string'
                  ? event.payload.provider
                  : typeof event.payload?.providerId === 'string'
                    ? event.payload.providerId
                    : input.providerId,
              userId: input.userId,
              rawInput: input.intent,
              contextSnapshotId,
              startedAt: new Date(event.ts).toISOString(),
            })
            contextService.appendCoordEvent({
              projectId: input.projectId,
              type: 'run_created',
              nodeId,
              runId,
              payload: {
                intent: input.intent,
                contextSnapshotId,
              },
              actorId: input.userId,
            });
          }
          collector?.absorb(event)
          if (event.type === 'run_completed' || event.type === 'run_failed') {
            const loopRecord = collector?.toRecord()
            if (loopRecord) {
              const record = contextService.recordAgentLoop(loopRecord)
              void synapseContextAgentService.processAgentLoop({
                projectId: input.projectId,
                loopRecord: record,
                actorId: input.userId,
                locale: 'zh',
                workDir: input.context?.workDir ?? null,
              })
            }
          } else {
            contextService.appendCoordEvent({
              projectId: input.projectId,
              type: 'run_event_observed',
              nodeId,
              runId,
              payload: {
                eventType: event.type,
                ts: event.ts,
                clusterId: event.clusterId,
              },
              actorId: 'agent',
            });
          }
        }
        await stream.writeSSE({ data: JSON.stringify(event) })
        eventCount++
      }
      // Signal end of stream
      await stream.writeSSE({ data: '[DONE]' })
      logger.info({ projectId: input.projectId, eventCount }, 'Stream dispatch finished')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ error: message }, 'Stream dispatch failed')
      if (collector && currentRunId) {
        collector.absorb({
          type: 'run_failed',
          ts: Date.now(),
          runId: currentRunId,
          clusterId: input.context?.selectedClusterId ?? 'default-cluster',
          intent: input.intent,
          payload: { reason: message, message },
        })
        const record = contextService.recordAgentLoop(collector.toRecord())
        void synapseContextAgentService.processAgentLoop({
          projectId: input.projectId,
          loopRecord: record,
          actorId: input.userId,
          locale: 'zh',
          workDir: input.context?.workDir ?? null,
        })
      }
      // Send error event before closing
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'run_failed',
          ts: Date.now(),
          runId: 'error',
          clusterId: input.context?.selectedClusterId ?? 'default-cluster',
          intent: input.intent,
          payload: { reason: message, message },
        }),
      })
      await stream.writeSSE({ data: '[DONE]' })
    }
  })
});

/**
 * POST /dispatch — 批量端点（保留兼容，等待所有事件后一次性返回）
 */
coordinatesRoutes.post('/dispatch', async (c) => {
  logger.info({ path: '/dispatch' }, 'Batch dispatch request received');

  try {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // Validate input
    const parsed = dispatchSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Dispatch validation failed');
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const input: DispatchIntentInput = parsed.data;
    logger.info({ projectId: input.projectId, intent: input.intent }, 'Batch dispatch starting');

    // Create ACP client and dispatch
    const acpClient = await createAcpClientForProject(input.projectId);
    const result = await acpClient.dispatch(input);

    logger.info({ runId: result.runId, eventCount: result.events.length }, 'Batch dispatch completed');
    return c.json({
      runId: result.runId,
      provider: result.provider,
      events: result.events,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: message }, 'Batch dispatch failed');
    return c.json({ error: message }, 500);
  }
});
