// ---------------------------------------------------------------------------
// api/services/wiki/wiki-refresh-service.ts
//
// Wiki refresh：增量索引 → hash-diff stale 检测 → 按文档分组 → LLM 生成 document drafts
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiRefreshTasks, wikiRefreshDrafts, wikiScanCache } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { runCodeMapScan, compareScans, type ScanDiff } from '../analyzer/scan.js';
import { buildAnalyzerGraph } from '../analyzer/graph.js';
import { computeBlastRadius } from '../analyzer/graph.js';
import { resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js';
import { generateGatewayObject } from '../llm-runtime/gateway.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notify.js';
import type { WikiRefreshTask, WikiBlock, DraftBlockChange } from './contracts.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';
import * as z from 'zod/v4';

// ── Document draft output schema ─────────────────────────────────────────────

const DocumentDraftOutputSchema = z.object({
  summary: z.string().max(200),
  changes: z.array(z.object({
    blockId: z.string(),
    action: z.enum(['update', 'delete', 'insert_after']),
    newContent: z.unknown().nullable(),
    reasoning: z.string(),
    confidence: z.number().min(0).max(1),
    risk: z.enum(['low', 'medium', 'high']),
  })),
});

type DocumentDraftOutput = z.infer<typeof DocumentDraftOutputSchema>;

function rowToTask(r: typeof wikiRefreshTasks.$inferSelect): WikiRefreshTask {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    baseRepoIndexId: r.baseRepoIndexId ?? null,
    nextRepoIndexId: r.nextRepoIndexId ?? null,
    status: r.status as WikiRefreshTask['status'],
    priority: r.priority as WikiRefreshTask['priority'],
    affectedBlockIds: JSON.parse(r.affectedBlockIdsJson) as string[],
    patchIds: JSON.parse(r.patchIdsJson) as string[],
    draftIds: JSON.parse(r.draftIdsJson) as string[],
    affectedDocumentIds: JSON.parse(r.affectedDocumentIdsJson) as string[],
    errorMessage: r.errorMessage ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt ?? null,
  };
}

// PLACEHOLDER_REST

async function updateTask(
  taskId: string,
  updates: Partial<typeof wikiRefreshTasks.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db.update(wikiRefreshTasks).set({
    ...updates,
    updatedAt: new Date().toISOString(),
  }).where(eq(wikiRefreshTasks.id, taskId));
}

export const wikiRefreshService = {
  async getTask(taskId: string): Promise<WikiRefreshTask | null> {
    const db = getDb();
    const rows = await db.select().from(wikiRefreshTasks).where(eq(wikiRefreshTasks.id, taskId)).limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  },

  async triggerRefresh(
    projectId: string,
    snapshotId: string,
    workDir: string,
  ): Promise<WikiRefreshTask> {
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = nanoid();
    const workDirAbs = resolveWorkspaceRoot(workDir);

    await db.insert(wikiRefreshTasks).values({
      id: taskId,
      projectId,
      snapshotId,
      status: 'queued',
      priority: 'p1',
      affectedBlockIdsJson: '[]',
      patchIdsJson: '[]',
      draftIdsJson: '[]',
      affectedDocumentIdsJson: '[]',
      createdAt: now,
      updatedAt: now,
    });

    this._runRefresh(taskId, projectId, snapshotId, workDirAbs).catch(err => {
      logger.error({ err, taskId }, 'wiki refresh: unhandled error');
    });

    return (await this.getTask(taskId))!;
  },

// PLACEHOLDER_RUN_REFRESH

  async _runRefresh(
    taskId: string,
    projectId: string,
    snapshotId: string,
    workDir: string,
  ): Promise<void> {
    notify({
      type: 'task_started',
      taskKind: 'wiki_refresh',
      projectId,
      taskId,
      title: 'Wiki 刷新',
      message: '文档刷新检查已启动',
      severity: 'info',
    });

    try {
      // Phase 1: scanning
      await updateTask(taskId, { status: 'scanning' });
      const previousScan = await loadCachedScan(projectId);
      const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });
      const nextRepoIndexId = scan.scanId;
      await updateTask(taskId, { nextRepoIndexId });

      const graph = buildAnalyzerGraph(scan.codeIndex);
      let scanDiff: ScanDiff | null = null;
      if (previousScan) {
        scanDiff = compareScans(previousScan, scan);
        logger.info({ taskId, diffEntries: scanDiff.entries.length }, 'wiki refresh: scan diff computed');
      }
      await persistScanCache(projectId, scan);

      // Phase 2: stale detection
      await updateTask(taskId, { status: 'stale_checking' });
      const snapshot = await wikiStore.getSnapshot(snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

      const baseRepoIndexId = snapshot.repoIndexId ?? nextRepoIndexId;
      await updateTask(taskId, { baseRepoIndexId });

      const { changedBindingIds, changedSourceIds } = await wikiCoordinateService.detectChangedBindings(
        projectId, scan.codeIndex,
      );

      // Blast radius via call graph
      let blastRadiusSourceIds: string[] = [];
      if (scanDiff && scanDiff.entries.length > 0) {
        const changedSymbolIds = scanDiff.entries
          .filter(e => e.kind === 'symbol_added' || e.kind === 'symbol_removed' || e.kind === 'symbol_modified')
          .map(e => e.entityId);
        if (changedSymbolIds.length > 0) {
          const blastRadius = computeBlastRadius(changedSymbolIds, graph.reverseCallGraph);
          blastRadiusSourceIds = [...blastRadius]
            .map(symId => scan.codeIndex.symbols.find(s => s.id === symId)?.fileId)
            .filter((id): id is string => Boolean(id));
        }
      }

// PLACEHOLDER_RUN_REFRESH_2

      // Find affected blocks
      const allChangedSourceIds = [...new Set([...changedSourceIds, ...blastRadiusSourceIds])];
      const indexLookup = await wikiCoordinateService.getBlockIdsBySourceIds(
        projectId, baseRepoIndexId, allChangedSourceIds,
      );
      const fromIndex = [...indexLookup.values()].flat();
      const fromBindings = await wikiCoordinateService.getBlockIdsByBindingIds(changedBindingIds);
      const affectedBlockIds = [...new Set([...fromIndex, ...fromBindings])];

      await updateTask(taskId, { affectedBlockIdsJson: JSON.stringify(affectedBlockIds) });

      if (affectedBlockIds.length > 0) {
        await wikiStore.markBlocksStale(affectedBlockIds, 'stale');
      }

      await wikiCoordinateService.refreshVerifiedHashes(projectId, nextRepoIndexId, scan.codeIndex);

      // Phase 3: group by document and generate drafts
      await updateTask(taskId, { status: 'drafting' });
      const documentBlockMap = await this._groupBlocksByDocument(affectedBlockIds);
      const affectedDocumentIds = [...documentBlockMap.keys()];
      await updateTask(taskId, { affectedDocumentIdsJson: JSON.stringify(affectedDocumentIds) });

      const draftIds: string[] = [];
      for (const [documentId, blockIds] of documentBlockMap) {
        const draftId = await this._createDocumentDraft(
          projectId, snapshotId, taskId, documentId, blockIds, scan, scanDiff,
        );
        if (draftId) draftIds.push(draftId);
      }

      await updateTask(taskId, {
        status: 'completed',
        draftIdsJson: JSON.stringify(draftIds),
        completedAt: new Date().toISOString(),
      });

      notify({
        type: 'task_completed',
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: 'Wiki 刷新完成',
        message: `${affectedDocumentIds.length} 个文档受影响，生成 ${draftIds.length} 个草稿`,
        severity: draftIds.length > 0 ? 'warning' : 'success',
        meta: { affectedDocuments: affectedDocumentIds.length, drafts: draftIds.length },
      });

      logger.info(
        { taskId, affectedDocuments: affectedDocumentIds.length, drafts: draftIds.length },
        'wiki refresh: complete',
      );
    } catch (err) {
      logger.error({ err, taskId }, 'wiki refresh: failed');
      notify({
        type: 'task_failed',
        taskKind: 'wiki_refresh',
        projectId,
        taskId,
        title: 'Wiki 刷新失败',
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      });
      await updateTask(taskId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

// PLACEHOLDER_HELPERS

  async _groupBlocksByDocument(blockIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    for (const blockId of blockIds) {
      const block = await wikiStore.getBlock(blockId);
      if (!block) continue;
      const existing = map.get(block.documentId) ?? [];
      existing.push(blockId);
      map.set(block.documentId, existing);
    }
    return map;
  },

  async _createDocumentDraft(
    projectId: string,
    snapshotId: string,
    taskId: string,
    documentId: string,
    affectedBlockIds: string[],
    scan: Awaited<ReturnType<typeof runCodeMapScan>>,
    scanDiff: ScanDiff | null,
  ): Promise<string | null> {
    const db = getDb();
    const now = new Date().toISOString();
    const draftId = nanoid();

    const allBlocks = await wikiStore.getBlocksByDocument(documentId);
    if (allBlocks.length === 0) return null;

    const doc = await wikiStore.getDocument(documentId);
    const docTitle = doc?.title ?? 'Unknown';
    const docType = doc?.docType ?? 'module_design';

    // Gather source context from all affected blocks' bindings
    const allSourceFiles = new Set<string>();
    const allSymbols = new Set<string>();
    for (const blockId of affectedBlockIds) {
      const bindings = await wikiStore.getBindingsByBlock(blockId);
      for (const b of bindings) {
        if (b.sourceType === 'symbol') {
          const sym = scan.codeIndex.symbols.find(s => s.id === b.sourceId);
          if (sym) allSymbols.add(`${sym.qualifiedName} [${sym.kind}]`);
        }
        const file = scan.codeIndex.files.find(f => f.id === b.sourceId);
        if (file) allSourceFiles.add(file.path);
        if (b.filePath) allSourceFiles.add(b.filePath);
      }
    }

    const sourceFilesList = [...allSourceFiles].slice(0, 15);
    const symbolsList = [...allSymbols].slice(0, 20);
    const diffContext = buildDiffContext(scanDiff, sourceFilesList);

// PLACEHOLDER_LLM_CALL

    // Build document content representation for LLM
    const blocksContext = allBlocks.map(b => ({
      id: b.id,
      type: b.blockType,
      format: b.contentFormat,
      content: JSON.stringify(b.content).slice(0, 600),
      isAffected: affectedBlockIds.includes(b.id),
    }));

    let draftOutput: DocumentDraftOutput | null = null;
    try {
      draftOutput = await generateGatewayObject(
        {
          purpose: 'wiki',
          projectId,
          messages: [
            {
              role: 'system',
              content: `You are a senior software architect. Given a design document and code changes, output which blocks need updating.
Rules:
- Only output blocks that actually need modification due to the code changes.
- Keep each block's original blockType and contentFormat.
- Provide a one-sentence reasoning per block explaining what changed.
- If no blocks need updating, return an empty changes array.
- Output valid JSON matching the schema exactly.`,
            },
            {
              role: 'user',
              content: `Document: "${docTitle}" (type: ${docType})

Blocks:
${blocksContext.map(b => `[${b.id}] (${b.type}, affected=${b.isAffected}): ${b.content}`).join('\n\n')}

Changed source files: ${sourceFilesList.join(', ') || 'unknown'}
Related symbols: ${symbolsList.join(', ') || 'none'}
${diffContext}
Output the blocks that need updating to reflect these code changes.`,
            },
          ],
        },
        DocumentDraftOutputSchema,
      );
    } catch (err) {
      logger.warn({ err, documentId }, 'wiki refresh: document draft LLM failed');
    }

    if (!draftOutput || draftOutput.changes.length === 0) return null;

    // Build changes with oldContent
    const changes: DraftBlockChange[] = draftOutput.changes.map(c => {
      const block = allBlocks.find(b => b.id === c.blockId);
      return {
        blockId: c.blockId,
        action: c.action,
        oldContent: block?.content ?? null,
        newContent: c.newContent,
        reasoning: c.reasoning,
        confidence: c.confidence,
        risk: c.risk,
      };
    });

    const risks = changes.map(c => c.risk);
    const aggregateRisk = risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : 'low';
    const aggregateConfidence = changes.reduce((sum, c) => sum + c.confidence, 0) / changes.length;

    // Get current commit SHA for freshness tracking
    let sourceCommitSha: string | null = null;
    try {
      const snapshot = await wikiStore.getSnapshot(snapshotId);
      sourceCommitSha = snapshot?.headCommitSha ?? null;
    } catch { /* ignore */ }

    await db.insert(wikiRefreshDrafts).values({
      id: draftId,
      projectId,
      snapshotId,
      refreshTaskId: taskId,
      documentId,
      status: 'ready',
      changesJson: JSON.stringify(changes),
      summary: draftOutput.summary,
      aggregateRisk,
      aggregateConfidence,
      sourceCommitSha,
      createdAt: now,
    });

    return draftId;
  },
};

// ── Scan Cache Helpers ────────────────────────────────────────────────────────

async function loadCachedScan(projectId: string): Promise<CodeMapScanResult | null> {
  try {
    const db = getDb();
    const rows = await db.select().from(wikiScanCache).where(eq(wikiScanCache.projectId, projectId)).limit(1);
    if (!rows[0]) return null;
    const row = rows[0];
    const codeIndex = JSON.parse(row.codeIndexJson);
    const communities = row.communitiesJson ? JSON.parse(row.communitiesJson) : null;
    return {
      projectId,
      scanId: row.scanId,
      generatedAt: 0,
      durationMs: 0,
      workDir: '',
      source: null,
      codeIndex,
      semanticGraph: { nodes: [], edges: [] },
      communities,
      warnings: [],
    };
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki refresh: failed to load cached scan');
    return null;
  }
}

async function persistScanCache(projectId: string, scan: CodeMapScanResult): Promise<void> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const codeIndexJson = JSON.stringify(scan.codeIndex);
    const communitiesJson = scan.communities ? JSON.stringify(scan.communities) : null;
    await db.insert(wikiScanCache).values({
      projectId,
      scanId: scan.scanId,
      codeIndexJson,
      communitiesJson,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: wikiScanCache.projectId,
      set: { scanId: scan.scanId, codeIndexJson, communitiesJson, updatedAt: now },
    });
  } catch (err) {
    logger.warn({ err, projectId }, 'wiki refresh: failed to persist scan cache');
  }
}

function buildDiffContext(scanDiff: ScanDiff | null, sourceFiles: string[]): string {
  if (!scanDiff || scanDiff.entries.length === 0) return '';
  const relevant = scanDiff.entries
    .filter(e => !e.path || sourceFiles.some(f => e.path?.includes(f) || f.includes(e.path!)))
    .slice(0, 10);
  if (relevant.length === 0) return `\nChange summary: ${scanDiff.summary}\n`;
  const lines = relevant.map(e => {
    const path = e.path ? ` (${e.path})` : '';
    return `- ${e.kind}${path}`;
  });
  return `\nChange summary: ${scanDiff.summary}\nDetailed changes:\n${lines.join('\n')}\n`;
}
