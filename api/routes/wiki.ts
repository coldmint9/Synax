import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import { wikiStore } from '../services/wiki/wiki-store.js';
import { wikiExportService } from '../services/wiki/wiki-export-service.js';
import { wikiSnapshotService } from '../services/wiki/wiki-snapshot-service.js';
import { wikiLoopService } from '../services/wiki/wiki-loop-service.js';
import { wikiCoordinateService } from '../services/wiki/wiki-coordinate-service.js';
import { wikiRefreshService } from '../services/wiki/wiki-refresh-service.js';
import { wikiPatchService, WikiPatchConflictError } from '../services/wiki/wiki-patch-service.js';
import { wikiDesignMappingService } from '../services/wiki/wiki-design-mapping-service.js';
import { assertLlmProviderConfigured } from '../services/llm-runtime/provider-check.js';
import { AgentProviderNotConfiguredError } from '../services/agent-runtime/runtime-errors.js';
import { logger } from '../lib/logger.js';

export const wikiRoutes = new Hono();

// ── Input schemas ────────────────────────────────────────────────────────────

const generateBodySchema = z.object({
  workDir: z.string().min(1).max(4096),
  locale: z.enum(['zh', 'en']).optional(),
});

const refreshBodySchema = z.object({
  workDir: z.string().min(1).max(4096),
  actorId: z.string().max(128).optional(),
});

const patchActionBodySchema = z.object({
  actorId: z.string().max(128).optional(),
  confirmManualOverride: z.boolean().optional(),
});

const blockUpdateBodySchema = z.object({
  content: z.unknown(),
  manualState: z.enum(['edited', 'locked']).optional(),
  actorId: z.string().max(128).optional(),
});

const designMappingPlanBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  snapshotId: z.string().min(1).max(128),
  selectedBlockIds: z.array(z.string().max(128)).max(64).optional(),
  selectedText: z.string().max(8192).optional(),
  instruction: z.string().min(1).max(4096),
});

const designMappingConfirmBodySchema = z.object({
  workDir: z.string().min(1).max(4096).optional(),
  providerId: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
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

// ── GET /api/wiki/projects/:projectId/latest ─────────────────────────────────
wikiRoutes.get('/projects/:projectId/latest', async (c) => {
  const { projectId } = c.req.param();
  const snapshot = await wikiStore.getLatestSnapshot(projectId);
  if (!snapshot) {
    return c.json({ snapshot: null, documents: [], blocks: [], sourceBindings: [], patchesSummary: { pending: 0, conflict: 0 } });
  }
  const tree = await wikiStore.getSnapshotTree(snapshot.id);
  return c.json(tree);
});

// ── GET /api/wiki/snapshots/:snapshotId ──────────────────────────────────────
wikiRoutes.get('/snapshots/:snapshotId', async (c) => {
  const { snapshotId } = c.req.param();
  const tree = await wikiStore.getSnapshotTree(snapshotId);
  if (!tree) return c.json({ error: 'not found' }, 404);
  return c.json(tree);
});

// ── PATCH /api/wiki/blocks/:blockId ──────────────────────────────────────────
wikiRoutes.patch('/blocks/:blockId', async (c) => {
  const { blockId } = c.req.param();
  const parsed = await parseBody(c, blockUpdateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const block = await wikiStore.getBlock(blockId);
  if (!block) return c.json({ error: 'not found' }, 404);
  const updated = await wikiStore.updateBlockContent(blockId, {
    content: parsed.data.content,
    manualState: parsed.data.manualState,
    actorId: parsed.data.actorId,
  });
  return c.json(updated);
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

  // Fire-and-forget: client polls /latest for completion
  void wikiLoopService.generate({
    projectId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch((err) => {
    logger.error({ err, projectId }, '[wiki] generate task failed before service handler completed');
  });

  return c.json({ status: 'queued', message: 'Wiki generation started. Poll /latest for status.' });
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

  await wikiStore.purgeProject(projectId);

  void wikiLoopService.generate({
    projectId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch((err) => {
    logger.error({ err, projectId }, '[wiki] reinitialize task failed before service handler completed');
  });

  return c.json({ status: 'queued', message: 'Wiki purged and regeneration started. Poll /latest for status.' });
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

  return c.json({ status: 'queued', message: 'Wiki continue generation started. Poll /latest for status.' });
});

// ── GET /api/wiki/source-bindings/:bindingId/resolve ─────────────────────────
wikiRoutes.get('/source-bindings/:bindingId/resolve', async (c) => {
  const { bindingId } = c.req.param();
  // Locator is persisted on the binding row — no scan required.
  const resolution = await wikiCoordinateService.resolveBinding(bindingId);
  return c.json(resolution);
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
    const task = await wikiRefreshService.triggerRefresh(snapshot.projectId, snapshotId, parsed.data.workDir);
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

// ── POST /api/wiki/patches/:patchId/accept ───────────────────────────────────
wikiRoutes.post('/patches/:patchId/accept', async (c) => {
  const { patchId } = c.req.param();
  const parsed = await parseBody(c, patchActionBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const patch = await wikiPatchService.accept(patchId, parsed.data);
    return c.json(patch);
  } catch (err) {
    if (err instanceof WikiPatchConflictError) {
      return c.json({ error: err.message, code: 'manual_override_required', blockId: err.blockId, manualState: err.manualState }, 409);
    }
    throw err;
  }
});

// ── POST /api/wiki/patches/:patchId/dismiss ──────────────────────────────────
wikiRoutes.post('/patches/:patchId/dismiss', async (c) => {
  const { patchId } = c.req.param();
  const parsed = await parseBody(c, patchActionBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const patch = await wikiPatchService.dismiss(patchId, { actorId: parsed.data.actorId });
  return c.json(patch);
});

// ── POST /api/wiki/design-mapping/plan ───────────────────────────────────────
wikiRoutes.post('/design-mapping/plan', async (c) => {
  const parsed = await parseBody(c, designMappingPlanBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    assertLlmProviderConfigured(parsed.data.projectId);
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ projectId: parsed.data.projectId }, '[wiki] LLM provider not configured for design-mapping plan');
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  const result = await wikiDesignMappingService.plan({
    projectId: parsed.data.projectId,
    snapshotId: parsed.data.snapshotId,
    selectedBlockIds: parsed.data.selectedBlockIds ?? [],
    selectedText: parsed.data.selectedText ?? '',
    instruction: parsed.data.instruction,
  });
  return c.json(result);
});

// ── POST /api/wiki/design-mapping/:taskId/confirm ────────────────────────────
wikiRoutes.post('/design-mapping/:taskId/confirm', async (c) => {
  const { taskId } = c.req.param();
  const parsed = await parseBody(c, designMappingConfirmBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    assertLlmProviderConfigured();
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ taskId }, '[wiki] LLM provider not configured for design-mapping confirm');
      return c.json({ error: err.message, code: err.code }, 422);
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }

  try {
    const result = await wikiDesignMappingService.confirm(taskId, parsed.data);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'confirm failed' }, 400);
  }
});

// ── GET /api/wiki/design-mapping/:taskId ─────────────────────────────────────
wikiRoutes.get('/design-mapping/:taskId', async (c) => {
  const { taskId } = c.req.param();
  const task = await wikiDesignMappingService.getTask(taskId);
  if (!task) return c.json({ error: 'not found' }, 404);
  return c.json(task);
});

// ── GET /api/wiki/projects/:projectId/patches ────────────────────────────────
wikiRoutes.get('/projects/:projectId/patches', async (c) => {
  const { projectId } = c.req.param();
  const status = c.req.query('status') as 'pending' | 'accepted' | 'dismissed' | undefined;
  const patches = await wikiStore.getPatchesByProject(projectId, status);
  return c.json({ patches });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Evaluations & Plans
// ═══════════════════════════════════════════════════════════════════════════════

import * as evalService from '../services/wiki/wiki-evaluation-service.js';
import { generatePlan, generatePlanStream } from '../services/wiki/wiki-plan-generator.js';

const createEvalBodySchema = z.object({
  blockId: z.string().min(1).max(128),
  content: z.string().min(1).max(4096),
});

// ── GET /api/wiki/projects/:projectId/evaluations ────────────────────────────
wikiRoutes.get('/projects/:projectId/evaluations', async (c) => {
  const { projectId } = c.req.param();
  const status = c.req.query('status') || undefined;
  const evaluations = await evalService.listEvaluations(projectId, status);
  return c.json({ evaluations });
});

// ── POST /api/wiki/projects/:projectId/evaluations ───────────────────────────
wikiRoutes.post('/projects/:projectId/evaluations', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, createEvalBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const evaluation = await evalService.createEvaluation(projectId, parsed.data.blockId, parsed.data.content);
  return c.json(evaluation, 201);
});

// ── DELETE /api/wiki/evaluations/:evalId ──────────────────────────────────────
wikiRoutes.delete('/evaluations/:evalId', async (c) => {
  const { evalId } = c.req.param();
  await evalService.deleteEvaluation(evalId);
  return c.json({ ok: true });
});

// ── PATCH /api/wiki/evaluations/:evalId/status ───────────────────────────────
wikiRoutes.patch('/evaluations/:evalId/status', async (c) => {
  const { evalId } = c.req.param();
  const parsed = await parseBody(c, z.object({ status: z.enum(['active', 'planned', 'resolved']) }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await evalService.updateEvaluationStatus(evalId, parsed.data.status);
  return c.json({ ok: true });
});

// ── GET /api/wiki/blocks/:blockId/evaluations ────────────────────────────────
wikiRoutes.get('/blocks/:blockId/evaluations', async (c) => {
  const { blockId } = c.req.param();
  const evaluations = await evalService.listEvaluationsByBlock(blockId);
  return c.json({ evaluations });
});

// ── GET /api/wiki/projects/:projectId/plans/active ───────────────────────────
wikiRoutes.get('/projects/:projectId/plans/active', async (c) => {
  const { projectId } = c.req.param();
  const plan = await evalService.getActivePlan(projectId);
  if (!plan) return c.json({ plan: null, nodes: [] });
  const nodes = await evalService.listPlanNodes(plan.id);
  return c.json({ plan, nodes });
});

// ── POST /api/wiki/projects/:projectId/plans/:planId/confirm ─────────────────
wikiRoutes.post('/projects/:projectId/plans/:planId/confirm', async (c) => {
  const { planId } = c.req.param();
  await evalService.confirmPlan(planId);
  return c.json({ ok: true });
});

// ── POST /api/wiki/projects/:projectId/plans/generate ────────────────────────
wikiRoutes.post('/projects/:projectId/plans/generate', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, z.object({
    snapshotId: z.string().min(1).max(128),
    workDir: z.string().min(1).max(4096),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  // Multi-round rule: only one active (non-completed) plan at a time
  const existing = await evalService.getActivePlan(projectId);
  if (existing) {
    return c.json({ error: 'An active plan already exists. Complete or discard it first.', code: 'PLAN_ALREADY_EXISTS' }, 409);
  }

  try {
    assertLlmProviderConfigured(projectId);
    const result = await generatePlan(projectId, parsed.data.snapshotId, parsed.data.workDir);
    const plan = await evalService.getPlan(result.planId);
    const nodes = await evalService.listPlanNodes(result.planId);
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
    workDir: z.string().min(1).max(4096),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const existing = await evalService.getActivePlan(projectId);
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

  const { snapshotId, workDir } = parsed.data;

  return streamSSE(c, async (stream) => {
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
    }, 10_000);

    try {
      for await (const event of generatePlanStream(projectId, snapshotId, workDir)) {
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
  const plans = await evalService.listPlans(projectId);
  return c.json({ plans });
});

// ── GET /api/wiki/plans/:planId ──────────────────────────────────────────────
wikiRoutes.get('/plans/:planId', async (c) => {
  const { planId } = c.req.param();
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  const nodes = await evalService.listPlanNodes(planId);
  const artifacts = await evalService.listArtifacts(planId);
  return c.json({ plan, nodes, artifacts });
});

// ── DELETE /api/wiki/plans/:planId ───────────────────────────────────────────
wikiRoutes.delete('/plans/:planId', async (c) => {
  const { planId } = c.req.param();
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status === 'completed') return c.json({ error: 'Completed plans cannot be discarded' }, 409);
  await evalService.updatePlanStatus(planId, 'completed');
  return c.json({ ok: true });
});

// ── POST /api/wiki/plans/:planId/nodes ───────────────────────────────────────
wikiRoutes.post('/plans/:planId/nodes', async (c) => {
  const { planId } = c.req.param();
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    title: z.string().min(1).max(256),
    description: z.string().max(4096).optional(),
    evaluationIds: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    expectedFiles: z.array(z.string()).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const nodes = await evalService.listPlanNodes(planId);
  const node = await evalService.createPlanNode({
    planId, projectId: plan.projectId,
    title: parsed.data.title, description: parsed.data.description,
    evaluationIds: parsed.data.evaluationIds,
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
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    nodeIds: z.array(z.string().min(1)).min(1),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await evalService.reorderPlanNodes(planId, parsed.data.nodeIds);
  return c.json({ ok: true });
});

// ── PATCH /api/wiki/plans/:planId/nodes/:nodeId ──────────────────────────────
wikiRoutes.patch('/plans/:planId/nodes/:nodeId', async (c) => {
  const { planId, nodeId } = c.req.param();
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  const parsed = await parseBody(c, z.object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().max(4096).optional(),
    evaluationIds: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    expectedFiles: z.array(z.string()).optional(),
  }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await evalService.updatePlanNode(nodeId, parsed.data);
  return c.json({ ok: true });
});

// ── DELETE /api/wiki/plans/:planId/nodes/:nodeId ─────────────────────────────
wikiRoutes.delete('/plans/:planId/nodes/:nodeId', async (c) => {
  const { planId, nodeId } = c.req.param();
  const plan = await evalService.getPlan(planId);
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (plan.status !== 'draft') return c.json({ error: 'Plan is not in draft' }, 409);
  await evalService.deletePlanNode(nodeId);
  return c.json({ ok: true });
});
