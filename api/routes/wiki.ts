import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import { wikiStore } from '../services/wiki/wiki-store.js';
import { wikiExportService } from '../services/wiki/wiki-export-service.js';
import { wikiLoopService } from '../services/wiki/wiki-loop-service.js';
import { wikiJobProcess } from '../services/wiki/wiki-job-process.js';
import { queueReinitialize } from '../services/wiki/wiki-reinitialize-service.js';
import { wikiWriteQueue } from '../services/wiki/wiki-write-queue-service.js';
import { wikiRefreshService } from '../services/wiki/wiki-refresh-service.js';
import { wikiDraftService } from '../services/wiki/wiki-draft-service.js';
import { getLatestWikiSnapshotTree, publishLatestWikiSnapshot, WikiSnapshotEventReason } from '../services/wiki/wiki-snapshot-events.js';
import { searchWikiDocuments } from '../services/wiki/wiki-fts.js';
import { WikiManualProtectionError } from '../services/wiki/contracts.js';
import { assertLlmProviderConfigured } from '../services/llm-runtime/provider-check.js';
import { AgentProviderNotConfiguredError } from '../services/agent-runtime/runtime-errors.js';
import { logger } from '../lib/logger.js';
import { SseEventType } from '../lib/sse-events.js';

export const wikiRoutes = new Hono();

// ── Input schemas ────────────────────────────────────────────────────────────

const generateBodySchema = z.object({
  workDir: z.string().min(1).max(4096),
  locale: z.enum(['zh', 'en']).optional(),
});

const refreshBodySchema = z.object({
  workDir: z.string().min(1).max(4096),
  actorId: z.string().max(128).optional(),
  locale: z.enum(['zh', 'en']).optional(),
});

const draftApplyBodySchema = z.object({
  actorId: z.string().max(128).optional(),
  confirmManualOverride: z.boolean().optional(),
});

const draftApplyPartialBodySchema = z.object({
  documentIds: z.array(z.string().min(1).max(128)).min(1),
  actorId: z.string().max(128).optional(),
  confirmManualOverride: z.boolean().optional(),
});

const draftEditBodySchema = z.object({
  changes: z.array(z.object({
    documentId: z.string().min(1).max(128),
    newContentMd: z.string().min(1),
  })).min(1),
  actorId: z.string().max(128).optional(),
  confirmManualOverride: z.boolean().optional(),
});

const documentUpdateBodySchema = z.object({
  contentMd: z.string(),
  references: z.array(z.object({
    filePath: z.string().min(1),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    symbol: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).optional(),
  manualState: z.enum(['edited', 'locked']).optional(),
  actorId: z.string().max(128).optional(),
});

async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, data: parsed.data };
}

// ── GET /api/wiki/snapshots/:snapshotId ──────────────────────────────────────
wikiRoutes.get('/snapshots/:snapshotId', async (c) => {
  const { snapshotId } = c.req.param();
  const tree = await wikiStore.getSnapshotTree(snapshotId);
  if (!tree) return c.json({ error: 'not found' }, 404);
  return c.json(tree);
});

// ── GET /api/wiki/projects/:projectId/search?q=&limit=&documentId= ─────────
wikiRoutes.get('/projects/:projectId/search', async (c) => {
  const { projectId } = c.req.param();
  const q = c.req.query('q') ?? '';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);
  const documentId = c.req.query('documentId') || undefined;

  if (!q.trim()) {
    return c.json({ results: [], total: 0 });
  }

  const results = searchWikiDocuments({ projectId, query: q, limit, documentId });

  // Enrich with document titles
  const docIds = [...new Set(results.map(r => r.documentId))];
  const docTitleMap = new Map<string, string>();
  if (docIds.length > 0) {
    const snapshot = await wikiStore.getLatestSnapshot(projectId);
    if (snapshot) {
      const docs = await wikiStore.getDocumentsBySnapshot(snapshot.id);
      for (const d of docs) {
        docTitleMap.set(d.id, d.title);
      }
    }
  }

  const enriched = results.map(r => ({
    ...r,
    documentTitle: docTitleMap.get(r.documentId) ?? '',
  }));

  return c.json({ results: enriched, total: enriched.length });
});

// ── PATCH /api/wiki/documents/:documentId ────────────────────────────────────
wikiRoutes.patch('/documents/:documentId', async (c) => {
  const { documentId } = c.req.param();
  const parsed = await parseBody(c, documentUpdateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const doc = await wikiStore.getDocument(documentId);
  if (!doc) return c.json({ error: 'not found' }, 404);

  try {
    const updated = await wikiStore.updateDocumentContent(documentId, {
      contentMd: parsed.data.contentMd,
      references: parsed.data.references,
      manualState: parsed.data.manualState ?? 'edited',
      actorId: parsed.data.actorId,
    });
    await publishLatestWikiSnapshot(updated.projectId, WikiSnapshotEventReason.DocumentUpdated);
    return c.json(updated);
  } catch (err) {
    if (err instanceof WikiManualProtectionError) {
      return c.json({ error: err.message, code: 'manual_override_required', documentId: err.documentId, manualState: err.manualState }, 409);
    }
    throw err;
  }
});

// ── GET /api/wiki/snapshots/:snapshotId/export.md ────────────────────────────
wikiRoutes.get('/snapshots/:snapshotId/export.md', async (c) => {
  const { snapshotId } = c.req.param();
  const includeSourceRefs = c.req.query('refs') === '1';
  try {
    const result = await wikiExportService.exportSnapshot(snapshotId, { includeSourceRefs });
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${result.fileName}"`);
    return c.body(result.content);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

// ── GET /api/wiki/documents/:documentId/export.md ────────────────────────────
wikiRoutes.get('/documents/:documentId/export.md', async (c) => {
  const { documentId } = c.req.param();
  const includeSourceRefs = c.req.query('refs') === '1';
  try {
    const result = await wikiExportService.exportDocument(documentId, { includeSourceRefs });
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${result.fileName}"`);
    return c.body(result.content);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

// ── GET /api/wiki/projects/:projectId/snapshot ───────────────────────────────
wikiRoutes.get('/projects/:projectId/snapshot', async (c) => {
  const { projectId } = c.req.param();
  const tree = await getLatestWikiSnapshotTree(projectId);
  return c.json(tree);
});

// ── POST /api/wiki/projects/:projectId/generate ──────────────────────────────
wikiRoutes.post('/projects/:projectId/generate', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, generateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    assertLlmProviderConfigured(projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ projectId }, '[wiki] LLM provider not configured for generate');
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  const activeGeneration = await wikiStore.hasActiveGeneration(projectId);
  if (activeGeneration.active) {
    return c.json({
      error: 'Wiki generation is already in progress for this project.',
      code: 'GENERATION_IN_PROGRESS',
      snapshotId: activeGeneration.snapshotId,
      status: activeGeneration.status,
    }, 409);
  }

  const workDir = parsed.data.workDir;
  const locale = parsed.data.locale ?? 'zh';

  if (wikiJobProcess.isRunning()) {
    return c.json({
      error: 'Wiki generation is already in progress for this project.',
      code: 'GENERATION_IN_PROGRESS',
    }, 409);
  }

  setImmediate(() => {
    const started = wikiJobProcess.start({
      kind: 'generate',
      projectId,
      workDir,
      locale,
    });
    if (!started) {
      logger.warn({ projectId }, '[wiki] failed to start wiki job child process');
    }
  });

  return c.json({ status: 'queued', message: 'Wiki generation started.' });
});

// ── POST /api/wiki/projects/:projectId/reinitialize ─────────────────────────
wikiRoutes.post('/projects/:projectId/reinitialize', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, generateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    assertLlmProviderConfigured(projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ projectId }, '[wiki] LLM provider not configured for reinitialize');
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  const activeGeneration = await wikiStore.hasActiveGeneration(projectId);
  if (activeGeneration.active) {
    return c.json({
      error: 'Wiki generation is already in progress for this project.',
      code: 'GENERATION_IN_PROGRESS',
      snapshotId: activeGeneration.snapshotId,
      status: activeGeneration.status,
    }, 409);
  }

  const queued = queueReinitialize({
    projectId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  });
  if (!queued) {
    return c.json({
      error: 'Wiki reinitialize is already in progress for this project.',
      code: 'GENERATION_IN_PROGRESS',
    }, 409);
  }

  return c.json({ status: 'queued', message: 'Wiki purge and regeneration queued.' });
});

// ── POST /api/wiki/snapshots/:snapshotId/continue ───────────────────────────
wikiRoutes.post('/snapshots/:snapshotId/continue', async (c) => {
  const { snapshotId } = c.req.param();
  const parsed = await parseBody(c, generateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const snapshot = await wikiStore.getSnapshot(snapshotId);
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);

  try {
    assertLlmProviderConfigured(snapshot.projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  void wikiLoopService.continueGeneration({
    snapshotId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch((err) => {
    logger.error({ err, snapshotId }, '[wiki] continue generation failed');
  });

  return c.json({ status: 'queued', message: 'Wiki continue generation started.' });
});

// ── POST /api/wiki/snapshots/:snapshotId/approve ────────────────────────────
wikiRoutes.post('/snapshots/:snapshotId/approve', async (c) => {
  const { snapshotId } = c.req.param();
  const parsed = await parseBody(c, generateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const snapshot = await wikiStore.getSnapshot(snapshotId);
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  if (snapshot.status !== 'outline_ready') {
    return c.json({ error: `Snapshot must be outline_ready to approve, got "${snapshot.status}"` }, 409);
  }

  try {
    assertLlmProviderConfigured(snapshot.projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  void wikiLoopService.approveOutline({
    snapshotId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch((err: unknown) => {
    logger.error({ err, snapshotId }, '[wiki] approve outline failed');
  });

  return c.json({ status: 'queued', message: 'Wiki content generation started.' });
});

// ── GET /api/wiki/snapshots/:snapshotId/write-queue ───────────────────────
wikiRoutes.get('/snapshots/:snapshotId/write-queue', async (c) => {
  const { snapshotId } = c.req.param();
  const snapshot = await wikiStore.getSnapshot(snapshotId);
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  const state = await wikiWriteQueue.getQueueState(snapshotId);
  return c.json(state);
});

// ── POST /api/wiki/snapshots/:snapshotId/pause ──────────────────────────────
wikiRoutes.post('/snapshots/:snapshotId/pause', async (c) => {
  const { snapshotId } = c.req.param();
  const snapshot = await wikiStore.getSnapshot(snapshotId);
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  if (snapshot.status !== 'writing') {
    return c.json({ error: `Snapshot must be writing to pause, got "${snapshot.status}"` }, 409);
  }

  try {
    await wikiWriteQueue.pauseBatch(snapshotId);
    return c.json({ status: 'paused', message: 'Wiki content generation paused.' });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'pause failed' }, 400);
  }
});


// ── POST /api/wiki/snapshots/:snapshotId/refresh ─────────────────────────────
wikiRoutes.post('/snapshots/:snapshotId/refresh', async (c) => {
  const { snapshotId } = c.req.param();
  const parsed = await parseBody(c, refreshBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const snapshot = await wikiStore.getSnapshot(snapshotId);
  if (!snapshot) return c.json({ error: 'snapshot not found' }, 404);

  try {
    assertLlmProviderConfigured(snapshot.projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ snapshotId, projectId: snapshot.projectId }, '[wiki] LLM provider not configured for refresh');
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  try {
    const task = await wikiRefreshService.triggerRefresh(snapshot.projectId, snapshotId, parsed.data.workDir, parsed.data.locale);
    return c.json({ task });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'refresh failed' }, 400);
  }
});

// ── GET /api/wiki/refresh-tasks/:taskId ──────────────────────────────────────
wikiRoutes.get('/refresh-tasks/:taskId', async (c) => {
  const { taskId } = c.req.param();
  const task = await wikiRefreshService.getTask(taskId);
  if (!task) return c.json({ error: 'not found' }, 404);
  return c.json(task);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Refresh Drafts
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/wiki/projects/:projectId/drafts ─────────────────────────────────
wikiRoutes.get('/projects/:projectId/drafts', async (c) => {
  const { projectId } = c.req.param();
  const status = c.req.query('status') || undefined;
  const drafts = await wikiDraftService.getDraftsByProject(projectId, status);
  return c.json({ drafts });
});

// ── GET /api/wiki/drafts/:draftId ────────────────────────────────────────────
wikiRoutes.get('/drafts/:draftId', async (c) => {
  const { draftId } = c.req.param();
  const draft = await wikiDraftService.getDraft(draftId);
  if (!draft) return c.json({ error: 'Draft not found' }, 404);
  return c.json(draft);
});

// ── POST /api/wiki/drafts/:draftId/apply ─────────────────────────────────────
wikiRoutes.post('/drafts/:draftId/apply', async (c) => {
  const { draftId } = c.req.param();
  const parsed = await parseBody(c, draftApplyBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await wikiDraftService.applyDraft(draftId, parsed.data);
    const draft = await wikiDraftService.getDraft(draftId);
    if (draft) await publishLatestWikiSnapshot(draft.projectId, WikiSnapshotEventReason.DraftApplied);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'apply failed' }, 400);
  }
});

// ── POST /api/wiki/drafts/:draftId/apply-partial ─────────────────────────────
wikiRoutes.post('/drafts/:draftId/apply-partial', async (c) => {
  const { draftId } = c.req.param();
  const parsed = await parseBody(c, draftApplyPartialBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await wikiDraftService.applyPartial(draftId, parsed.data.documentIds, {
      actorId: parsed.data.actorId,
      confirmManualOverride: parsed.data.confirmManualOverride,
    });
    const draft = await wikiDraftService.getDraft(draftId);
    if (draft) await publishLatestWikiSnapshot(draft.projectId, WikiSnapshotEventReason.DraftApplied);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'apply-partial failed' }, 400);
  }
});

// ── POST /api/wiki/drafts/:draftId/edit ──────────────────────────────────────
wikiRoutes.post('/drafts/:draftId/edit', async (c) => {
  const { draftId } = c.req.param();
  const parsed = await parseBody(c, draftEditBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await wikiDraftService.editAndApply(draftId, parsed.data.changes, {
      actorId: parsed.data.actorId,
      confirmManualOverride: parsed.data.confirmManualOverride,
    });
    const draft = await wikiDraftService.getDraft(draftId);
    if (draft) await publishLatestWikiSnapshot(draft.projectId, WikiSnapshotEventReason.DraftApplied);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'edit failed' }, 400);
  }
});

// ── POST /api/wiki/drafts/:draftId/discard ───────────────────────────────────
wikiRoutes.post('/drafts/:draftId/discard', async (c) => {
  const { draftId } = c.req.param();
  const parsed = await parseBody(c, draftApplyBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const draft = await wikiDraftService.discardDraft(draftId, { actorId: parsed.data.actorId });
    await publishLatestWikiSnapshot(draft.projectId, WikiSnapshotEventReason.DraftDiscarded);
    return c.json(draft);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'discard failed' }, 400);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Evaluations & Plans
// ═══════════════════════════════════════════════════════════════════════════════

import * as goalService from '../services/wiki/wiki-goal-service.js';
import * as planExecutor from '../services/wiki/wiki-plan-executor-service.js';
import { generatePlan, generatePlanStream } from '../services/wiki/wiki-plan-generator.js';
import { buildGoalSessionPrompt } from '../services/wiki/wiki-goal-prompt.js';
import { resolveGoalWikiContext } from '../services/wiki/wiki-goal-wiki-context.js';

const createGoalBodySchema = z.object({
  content: z.string().min(1).max(4096),
  scope: z.enum(['project', 'document']).optional(),
  documentId: z.string().min(1).max(128).optional().nullable(),
  anchorJson: z.object({
    type: z.enum(['heading', 'selection']),
    heading: z.string().optional(),
    quote: z.string().optional(),
  }).optional().nullable(),
});

const buildGoalSessionPromptBodySchema = z.object({
  mode: z.enum(['direct', 'plan_node']).optional(),
  content: z.string().min(1).max(100_000),
  documentId: z.string().nullable().optional(),
  documentTitle: z.string().nullable().optional(),
  anchorJson: createGoalBodySchema.shape.anchorJson,
  wikiAttachMode: z.enum(['auto', 'manual']).optional(),
  locale: z.enum(['zh', 'en']).optional(),
});

// ── POST /api/wiki/projects/:projectId/goals/session-prompt ────────────
wikiRoutes.post('/projects/:projectId/goals/session-prompt', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, buildGoalSessionPromptBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const wikiAttachMode = parsed.data.wikiAttachMode ?? 'manual';
  const wikiContext = await resolveGoalWikiContext({
    projectId,
    goalContent: parsed.data.content,
    mode: wikiAttachMode,
    documentId: parsed.data.documentId ?? null,
    anchorJson: parsed.data.anchorJson ?? null,
  });
  const prompt = buildGoalSessionPrompt({
    mode: parsed.data.mode ?? 'direct',
    content: parsed.data.content,
    documentId: wikiContext.documentId,
    documentTitle: wikiContext.documentTitle,
    anchorJson: wikiContext.anchorJson,
    wikiAttachMode: wikiContext.mode,
    wikiAutoMatched: wikiContext.autoMatched,
    locale: parsed.data.locale,
  });
  return c.json({ prompt, wikiContext });
});

// ── PATCH /api/wiki/goals/:goalId/last-session ─────────────────────────
wikiRoutes.patch('/goals/:goalId/last-session', async (c) => {
  const { goalId } = c.req.param();
  const parsed = await parseBody(c, z.object({ sessionId: z.string().min(1).max(64) }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await goalService.updateGoalLastSessionId(goalId, parsed.data.sessionId);
  return c.json({ ok: true });
});

// ── GET /api/wiki/projects/:projectId/goals ────────────────────────────
wikiRoutes.get('/projects/:projectId/goals', async (c) => {
  const { projectId } = c.req.param();
  const status = c.req.query('status') || undefined;
  const goals = await goalService.listGoals(projectId, status);
  return c.json({ goals });
});

// ── POST /api/wiki/projects/:projectId/goals ───────────────────────────
wikiRoutes.post('/projects/:projectId/goals', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, createGoalBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const goal = await goalService.createGoal({
    projectId,
    content: parsed.data.content,
    scope: parsed.data.scope,
    documentId: parsed.data.documentId,
    anchorJson: parsed.data.anchorJson ?? null,
  });
  return c.json(goal, 201);
});

// ── DELETE /api/wiki/goals/:goalId ──────────────────────────────────────
wikiRoutes.delete('/goals/:goalId', async (c) => {
  const { goalId } = c.req.param();
  await goalService.deleteGoal(goalId);
  return c.json({ ok: true });
});

// ── PATCH /api/wiki/goals/:goalId/status ───────────────────────────────
wikiRoutes.patch('/goals/:goalId/status', async (c) => {
  const { goalId } = c.req.param();
  const parsed = await parseBody(c, z.object({ status: z.enum(['active', 'planned', 'in_progress', 'resolved']) }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await goalService.updateGoalStatus(goalId, parsed.data.status);
  return c.json({ ok: true });
});

// ── GET /api/wiki/documents/:documentId/goals ──────────────────────────
wikiRoutes.get('/documents/:documentId/goals', async (c) => {
  const { documentId } = c.req.param();
  const goals = await goalService.listGoalsByDocument(documentId);
  return c.json({ goals });
});

// Legacy evaluation routes removed — use /goals

// ── GET /api/wiki/projects/:projectId/plans/active ───────────────────────────
wikiRoutes.get('/projects/:projectId/plans/active', async (c) => {
  const { projectId } = c.req.param();
  const plan = await goalService.getActivePlan(projectId);
  if (!plan) return c.json({ plan: null, nodes: [] });
  const nodes = await goalService.listPlanNodes(plan.id);
  return c.json({ plan, nodes });
});

// ── POST /api/wiki/projects/:projectId/plans/:planId/confirm ─────────────────
wikiRoutes.post('/projects/:projectId/plans/:planId/confirm', async (c) => {
  const { planId } = c.req.param();
  const parsed = await parseBody(c, z.object({
    workDir: z.string().min(1).optional(),
    locale: z.enum(['zh', 'en']).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await goalService.confirmPlan(planId);
  const workDir = parsed.data.workDir;
  const locale = parsed.data.locale ?? 'zh';
  void planExecutor.startExecution(planId, workDir, locale);
  return c.json({ ok: true });
});

// ── POST /api/wiki/projects/:projectId/plans/generate ────────────────────────
wikiRoutes.post('/projects/:projectId/plans/generate', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, z.object({
    snapshotId: z.string().min(1).max(128),
    locale: z.enum(['zh', 'en']).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  // Multi-round rule: only one active (non-completed) plan at a time
  const existing = await goalService.getActivePlan(projectId);
  if (existing) {
    return c.json({ error: 'An active plan already exists. Complete or discard it first.', code: 'PLAN_ALREADY_EXISTS' }, 409);
  }

  try {
    assertLlmProviderConfigured(projectId);
    const result = await generatePlan(projectId, parsed.data.snapshotId, parsed.data.locale);
    const plan = await goalService.getPlan(result.planId);
    const nodes = await goalService.listPlanNodes(result.planId);
    return c.json({ plan, nodes });
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      return c.json({ error: err.message, code: 'PROVIDER_NOT_CONFIGURED' }, 422);
    }
    logger.error({ err }, 'Plan generation failed');
    return c.json({ error: err instanceof Error ? err.message : 'Plan generation failed' }, 500);
  }
});

// ── POST /api/wiki/projects/:projectId/plans/generate/stream ─────────────────
wikiRoutes.post('/projects/:projectId/plans/generate/stream', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, z.object({
    snapshotId: z.string().min(1).max(128),
    locale: z.enum(['zh', 'en']).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const existing = await goalService.getActivePlan(projectId);
  if (existing) {
    return c.json({ error: 'An active plan already exists.', code: 'PLAN_ALREADY_EXISTS' }, 409);
  }

  try {
    assertLlmProviderConfigured(projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      return c.json({ error: err.message, code: 'PROVIDER_NOT_CONFIGURED' }, 422);
    }
    throw err;
  }

  const { snapshotId, locale } = parsed.data;

  return streamSSE(c, async (stream) => {
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: SseEventType.Ping, data: String(Date.now()) }).catch(() => {});
    }, 10_000);

    try {
      for await (const event of generatePlanStream(projectId, snapshotId, locale)) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Plan generation failed';
      await stream.writeSSE({ data: JSON.stringify({ type: 'failed', error: msg }) }).catch(() => {});
      logger.error({ err }, 'Plan stream generation failed');
    } finally {
      clearInterval(heartbeat);
    }
    await stream.writeSSE({ data: '[DONE]' }).catch(() => {});
  });
});

// ── GET /api/wiki/projects/:projectId/plans ──────────────────────────────────
wikiRoutes.get('/projects/:projectId/plans', async (c) => {
  const { projectId } = c.req.param();
  const plans = await goalService.listPlansWithSummary(projectId);
  return c.json({ plans });
});

// ── GET /api/wiki/plans/:planId ──────────────────────────────────────────────
wikiRoutes.get('/plans/:planId', async (c) => {
  const { planId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  const nodes = await goalService.listPlanNodes(planId);
  const artifacts = await goalService.listArtifacts(planId);
  return c.json({ plan, nodes, artifacts });
});

// ── DELETE /api/wiki/plans/:planId ───────────────────────────────────────────
wikiRoutes.delete('/plans/:planId', async (c) => {
  const { planId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  const permanent = c.req.query('permanent') === 'true';
  if (permanent) {
    await goalService.deletePlan(planId);
  } else {
    if (plan.status === 'completed' || plan.status === 'discarded') return c.json({ error: 'Plan already finalized' }, 409);
    await goalService.updatePlanStatus(planId, 'discarded');
  }
  return c.json({ ok: true });
});

// ── POST /api/wiki/plans/:planId/nodes ───────────────────────────────────────
wikiRoutes.post('/plans/:planId/nodes', async (c) => {
  const { planId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    title: z.string().min(1).max(256),
    description: z.string().max(4096).optional(),
    goalIds: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    expectedFiles: z.array(z.string()).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const nodes = await goalService.listPlanNodes(planId);
  const node = await goalService.createPlanNode({
    planId, projectId: plan.projectId,
    title: parsed.data.title, description: parsed.data.description,
    goalIds: parsed.data.goalIds,
    dependsOn: parsed.data.dependsOn,
    expectedFiles: parsed.data.expectedFiles,
    sortOrder: nodes.length,
  });
  return c.json(node, 201);
});

// ── PATCH /api/wiki/plans/:planId/nodes/reorder ─────────────────────────────
// Must be registered before :nodeId to avoid "reorder" matching as a nodeId
wikiRoutes.patch('/plans/:planId/nodes/reorder', async (c) => {
  const { planId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    nodeIds: z.array(z.string().min(1)).min(1),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await goalService.reorderPlanNodes(planId, parsed.data.nodeIds);
  return c.json({ ok: true });
});

// ── PATCH /api/wiki/plans/:planId/nodes/:nodeId ──────────────────────────────
wikiRoutes.patch('/plans/:planId/nodes/:nodeId', async (c) => {
  const { planId, nodeId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().max(4096).optional(),
    goalIds: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    expectedFiles: z.array(z.string()).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await goalService.updatePlanNode(nodeId, parsed.data);
  return c.json({ ok: true });
});

// ── DELETE /api/wiki/plans/:planId/nodes/:nodeId ─────────────────────────────
wikiRoutes.delete('/plans/:planId/nodes/:nodeId', async (c) => {
  const { planId, nodeId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  await goalService.deletePlanNode(nodeId);
  return c.json({ ok: true });
});

// ── GET /api/wiki/plans/:planId/execute/stream ─────────────────────────────
wikiRoutes.get('/plans/:planId/execute/stream', async (c) => {
  const { planId } = c.req.param();
  const plan = await goalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);

  return streamSSE(c, async (stream) => {
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: SseEventType.Ping, data: String(Date.now()) }).catch(() => {});
    }, 10_000);

    const unsub = planExecutor.subscribePlanExecution(planId, async (event) => {
      await stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    });

    try {
      await new Promise<void>((resolve) => {
        const check = planExecutor.subscribePlanExecution(planId, (event) => {
          if (event.type === 'plan_completed' || event.type === 'failed') {
            resolve();
          }
        });
        setTimeout(resolve, 30 * 60 * 1000);
        void check;
      });
    } finally {
      unsub();
      clearInterval(heartbeat);
    }
    await stream.writeSSE({ data: '[DONE]' }).catch(() => {});
  });
});

// ── POST /api/wiki/plans/:planId/nodes/:nodeId/accept ──────────────────────
wikiRoutes.post('/plans/:planId/nodes/:nodeId/accept', async (c) => {
  const { planId, nodeId } = c.req.param();
  const parsed = await parseBody(c, z.object({ workDir: z.string().min(1) }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await planExecutor.acceptPlanNode(planId, nodeId, parsed.data.workDir);
  return c.json({ ok: true });
});

// ── POST /api/wiki/plans/:planId/nodes/:nodeId/redo ────────────────────────
wikiRoutes.post('/plans/:planId/nodes/:nodeId/redo', async (c) => {
  const { planId, nodeId } = c.req.param();
  const parsed = await parseBody(c, z.object({
    feedback: z.string().min(1).max(4096),
    locale: z.enum(['zh', 'en']).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await planExecutor.redoPlanNode(planId, nodeId, parsed.data.feedback, parsed.data.locale ?? 'zh');
  return c.json({ ok: true });
});

// ── GET /api/wiki/plans/:planId/nodes/:nodeId/artifact ─────────────────────
wikiRoutes.get('/plans/:planId/nodes/:nodeId/artifact', async (c) => {
  const { nodeId } = c.req.param();
  const artifact = await goalService.getArtifact(nodeId);
  if (!artifact) return c.json({ error: 'Artifact not found' }, 404);
  return c.json({ artifact });
});
