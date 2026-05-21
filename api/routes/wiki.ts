import { Hono } from 'hono';
import type { Context } from 'hono';
import * as z from 'zod/v4';
import { wikiStore } from '../services/wiki/wiki-store.js';
import { wikiExportService } from '../services/wiki/wiki-export-service.js';
import { wikiSnapshotService } from '../services/wiki/wiki-snapshot-service.js';
import { wikiLoopService } from '../services/wiki/wiki-loop-service.js';
import { wikiCoordinateService } from '../services/wiki/wiki-coordinate-service.js';
import { wikiRefreshService } from '../services/wiki/wiki-refresh-service.js';
import { wikiPatchService, WikiPatchConflictError } from '../services/wiki/wiki-patch-service.js';
import { wikiDesignMappingService } from '../services/wiki/wiki-design-mapping-service.js';

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

  // Fire-and-forget: client polls /latest for completion
  void wikiLoopService.generate({
    projectId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch(() => { /* logged inside service */ });

  return c.json({ status: 'queued', message: 'Wiki generation started. Poll /latest for status.' });
});

// ── POST /api/wiki/projects/:projectId/reinitialize ─────────────────────────
wikiRoutes.post('/projects/:projectId/reinitialize', async (c) => {
  const { projectId } = c.req.param();
  const parsed = await parseBody(c, generateBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  await wikiStore.purgeProject(projectId);

  void wikiLoopService.generate({
    projectId,
    workDir: parsed.data.workDir,
    locale: parsed.data.locale ?? 'zh',
  }).catch(() => { /* logged inside service */ });

  return c.json({ status: 'queued', message: 'Wiki purged and regeneration started. Poll /latest for status.' });
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
