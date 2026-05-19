// ---------------------------------------------------------------------------
// api/services/wiki/wiki-refresh-service.ts
//
// 手动触发 Wiki refresh：增量索引 → hash-diff stale 检测 → Agent 语义复核 → pending patches
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiRefreshTasks, wikiPatches } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import { wikiCoordinateService } from './wiki-coordinate-service.js';
import { runCodeMapScan } from '../analyzer/scan.js';
import { resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js';
import { generateGatewayObject } from '../llm-runtime/stream.js';
import { logger } from '../../lib/logger.js';
import type { WikiRefreshTask, WikiBlock } from './contracts.js';
import * as z from 'zod/v4';

// ── Semantic review schema ────────────────────────────────────────────────────

const SemanticReviewOutputSchema = z.object({
  newContent: z.unknown(),
  reasoning: z.array(z.string()).min(1).max(5),
  confidence: z.number().min(0).max(1),
  risk: z.enum(['low', 'medium', 'high']),
});

type SemanticReviewOutput = z.infer<typeof SemanticReviewOutputSchema>;

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
    errorMessage: r.errorMessage ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt ?? null,
  };
}

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
      createdAt: now,
      updatedAt: now,
    });

    this._runRefresh(taskId, projectId, snapshotId, workDirAbs).catch(err => {
      logger.error({ err, taskId }, 'wiki refresh: unhandled error');
    });

    return (await this.getTask(taskId))!;
  },

  async _runRefresh(
    taskId: string,
    projectId: string,
    snapshotId: string,
    workDir: string,
  ): Promise<void> {
    try {
      // Phase 1: indexing
      await updateTask(taskId, { status: 'indexing' });
      const scan = await runCodeMapScan({ projectId, workDir, include: ['all'] });
      const nextRepoIndexId = scan.scanId;
      await updateTask(taskId, { nextRepoIndexId });

      // Phase 2: hash-diff stale check
      await updateTask(taskId, { status: 'stale_checking' });
      const snapshot = await wikiStore.getSnapshot(snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

      const baseRepoIndexId = snapshot.repoIndexId ?? nextRepoIndexId;
      await updateTask(taskId, { baseRepoIndexId });

      // Real diff: only bindings whose source hash actually changed (or was removed)
      const { changedBindingIds, changedSourceIds } = await wikiCoordinateService.detectChangedBindings(
        projectId,
        scan.codeIndex,
      );

      // Find affected blocks via reverse index OR direct binding lookup
      const indexLookup = await wikiCoordinateService.getBlockIdsBySourceIds(
        projectId,
        baseRepoIndexId,
        changedSourceIds,
      );
      const fromIndex = [...indexLookup.values()].flat();
      const fromBindings = await wikiCoordinateService.getBlockIdsByBindingIds(changedBindingIds);
      const affectedBlockIds = [...new Set([...fromIndex, ...fromBindings])];

      await updateTask(taskId, {
        affectedBlockIdsJson: JSON.stringify(affectedBlockIds),
      });

      if (affectedBlockIds.length > 0) {
        await wikiStore.markBlocksStale(affectedBlockIds, 'possibly_stale');
      }

      // Refresh verified hashes for unchanged sources
      await wikiCoordinateService.refreshVerifiedHashes(projectId, nextRepoIndexId, scan.codeIndex);

      // Phase 3: semantic review (P0/P1/P2 only — top 20)
      await updateTask(taskId, { status: 'semantic_reviewing' });
      const priorityBlocks = await this._getPriorityBlocks(affectedBlockIds, 20);

      // Phase 4: generate pending patches
      await updateTask(taskId, { status: 'patching' });
      const patchIds: string[] = [];
      for (const block of priorityBlocks) {
        const patchId = await this._createSemanticPatch(projectId, snapshotId, taskId, block, scan);
        if (patchId) patchIds.push(patchId);
      }

      await updateTask(taskId, {
        status: 'completed',
        patchIdsJson: JSON.stringify(patchIds),
        completedAt: new Date().toISOString(),
      });

      logger.info(
        { taskId, affectedBlocks: affectedBlockIds.length, patches: patchIds.length },
        'wiki refresh: complete',
      );
    } catch (err) {
      logger.error({ err, taskId }, 'wiki refresh: failed');
      await updateTask(taskId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async _getPriorityBlocks(blockIds: string[], limit: number): Promise<WikiBlock[]> {
    const blocks: WikiBlock[] = [];
    for (const id of blockIds.slice(0, limit)) {
      const block = await wikiStore.getBlock(id);
      if (block) blocks.push(block);
    }
    return blocks;
  },

  async _createSemanticPatch(
    projectId: string,
    snapshotId: string,
    taskId: string,
    block: WikiBlock,
    scan: Awaited<ReturnType<typeof runCodeMapScan>>,
  ): Promise<string | null> {
    const db = getDb();
    const now = new Date().toISOString();
    const patchId = nanoid();

    // Get current bindings for context
    const bindings = await wikiStore.getBindingsByBlock(block.id);
    const sourceFiles = bindings
      .map(b => scan.codeIndex.files.find(f => f.id === b.sourceId)?.path)
      .filter((p): p is string => Boolean(p))
      .slice(0, 5);

    // Build compact code context for the affected sources
    const sourceSymbols = bindings
      .flatMap(b => {
        if (b.sourceType === 'symbol') {
          const sym = scan.codeIndex.symbols.find(s => s.id === b.sourceId);
          return sym ? [`${sym.qualifiedName} [${sym.kind}]`] : [];
        }
        if (b.sourceType === 'file') {
          const file = scan.codeIndex.files.find(f => f.id === b.sourceId);
          return file ? [file.path] : [];
        }
        return [];
      })
      .slice(0, 10);

    // Call LLM to generate updated block content
    let reviewResult: SemanticReviewOutput | null = null;
    try {
      reviewResult = await generateGatewayObject(
        {
          purpose: 'wiki',
          projectId,
          messages: [
            {
              role: 'system',
              content: `You are a senior software architect reviewing a wiki block for accuracy after source code changes.
Given the current block content and the changed source code context, generate an updated version of the block.
Rules:
- Keep the same blockType and contentFormat as the original.
- Only update content that is factually affected by the code changes.
- If the block is still accurate, return the original content unchanged with confidence > 0.8.
- Provide 1-3 reasoning sentences explaining what changed and why.
- Output only valid json matching the schema exactly.`,
            },
            {
              role: 'user',
              content: `Block type: ${block.blockType}
Content format: ${block.contentFormat}
Current content: ${JSON.stringify(block.content).slice(0, 800)}

Changed source files: ${sourceFiles.join(', ') || 'unknown'}
Related symbols: ${sourceSymbols.join(', ') || 'none'}

Generate an updated version of this block reflecting the code changes.`,
            },
          ],
        },
        SemanticReviewOutputSchema,
      );
    } catch (err) {
      logger.warn({ err, blockId: block.id }, 'wiki refresh: semantic review LLM failed, using placeholder patch');
    }

    const newContent = reviewResult?.newContent ?? block.content;
    const confidence = reviewResult?.confidence ?? 0.5;
    const risk = reviewResult?.risk ?? (block.manualState === 'none' ? 'low' : 'high');
    const reasoning = reviewResult?.reasoning ?? [
      `Source code changed in ${sourceFiles.length > 0 ? sourceFiles.join(', ') : 'related files'}.`,
      `Block has ${bindings.length} source binding(s) verified at older revision.`,
      block.manualState !== 'none'
        ? `Block has manualState=${block.manualState} — accept will require explicit override.`
        : 'Block can be updated automatically once accepted.',
    ];

    await db.insert(wikiPatches).values({
      id: patchId,
      projectId,
      snapshotId,
      refreshTaskId: taskId,
      targetDocumentId: block.documentId,
      targetBlockIdsJson: JSON.stringify([block.id]),
      kind: 'update',
      status: 'pending',
      risk,
      confidence,
      oldContentJson: JSON.stringify(block.content),
      newContentJson: JSON.stringify(newContent),
      sourceDiffIdsJson: '[]',
      reasoningJson: JSON.stringify(reasoning),
      createdAt: now,
      updatedAt: now,
    });

    return patchId;
  },
};
