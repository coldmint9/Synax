// ---------------------------------------------------------------------------
// api/services/wiki/wiki-patch-service.ts
//
// WikiPatch accept / dismiss / regenerate
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { wikiPatches, wikiBlocks, wikiBlockRevisions } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import type { WikiPatch } from './contracts.js';

export class WikiPatchConflictError extends Error {
  constructor(public readonly blockId: string, public readonly manualState: string) {
    super(`Block ${blockId} has manualState=${manualState}. Pass confirmManualOverride=true to proceed.`);
    this.name = 'WikiPatchConflictError';
  }
}

function rowToPatch(r: typeof wikiPatches.$inferSelect): WikiPatch {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    refreshTaskId: r.refreshTaskId ?? null,
    agentSessionId: r.agentSessionId ?? null,
    targetDocumentId: r.targetDocumentId,
    targetBlockIds: JSON.parse(r.targetBlockIdsJson) as string[],
    kind: r.kind as WikiPatch['kind'],
    status: r.status as WikiPatch['status'],
    risk: r.risk as WikiPatch['risk'],
    confidence: r.confidence,
    oldContent: r.oldContentJson ? JSON.parse(r.oldContentJson) : null,
    newContent: JSON.parse(r.newContentJson),
    sourceDiffIds: JSON.parse(r.sourceDiffIdsJson) as string[],
    reasoning: JSON.parse(r.reasoningJson) as string[],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    decidedBy: r.decidedBy ?? null,
    decidedAt: r.decidedAt ?? null,
  };
}

export const wikiPatchService = {
  async getPatch(patchId: string): Promise<WikiPatch | null> {
    const db = getDb();
    const rows = await db.select().from(wikiPatches).where(eq(wikiPatches.id, patchId)).limit(1);
    return rows[0] ? rowToPatch(rows[0]) : null;
  },

  async accept(
    patchId: string,
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<WikiPatch> {
    const db = getDb();
    const patch = await this.getPatch(patchId);
    if (!patch) throw new Error(`WikiPatch not found: ${patchId}`);
    if (patch.status !== 'pending' && patch.status !== 'conflict') {
      throw new Error(`Patch ${patchId} is not in pending/conflict state (current: ${patch.status})`);
    }

    // Check manual protection on all target blocks
    for (const blockId of patch.targetBlockIds) {
      const block = await wikiStore.getBlock(blockId);
      if (!block) continue;
      if (block.manualState !== 'none' && !opts.confirmManualOverride) {
        // Mark patch as conflict so the UI surfaces it distinctly
        await db.update(wikiPatches).set({
          status: 'conflict',
          updatedAt: new Date().toISOString(),
        }).where(eq(wikiPatches.id, patchId));
        throw new WikiPatchConflictError(blockId, block.manualState);
      }
    }

    const now = new Date().toISOString();

    // Apply patch content to each target block
    for (const blockId of patch.targetBlockIds) {
      const block = await wikiStore.getBlock(blockId);
      if (!block) continue;

      if (patch.kind === 'delete') {
        // Mark as stale rather than hard-delete in MVP
        await wikiStore.markBlocksStale([blockId], 'stale');
        continue;
      }

      // Update block content directly (we already passed the manual protection check above)
      await db.update(wikiBlocks).set({
        contentJson: JSON.stringify(patch.newContent),
        staleState: 'fresh',
        updatedAt: now,
      }).where(eq(wikiBlocks.id, blockId));

      // Append a revision row
      const revisions = await db
        .select()
        .from(wikiBlockRevisions)
        .where(eq(wikiBlockRevisions.blockId, blockId))
        .orderBy(desc(wikiBlockRevisions.revision))
        .limit(1);
      const nextRevision = (revisions[0]?.revision ?? 0) + 1;
      const contentHash = createHash('sha256')
        .update(JSON.stringify(patch.newContent))
        .digest('hex')
        .slice(0, 32);
      await db.insert(wikiBlockRevisions).values({
        id: nanoid(),
        projectId: block.projectId,
        blockId,
        revision: nextRevision,
        contentJson: JSON.stringify(patch.newContent),
        contentHash,
        source: 'patch',
        patchId,
        createdAt: now,
        createdBy: opts.actorId ?? null,
      });
    }

    // Mark patch accepted
    await db.update(wikiPatches).set({
      status: 'accepted',
      decidedBy: opts.actorId ?? null,
      decidedAt: now,
      updatedAt: now,
    }).where(eq(wikiPatches.id, patchId));

    return (await this.getPatch(patchId))!;
  },

  async dismiss(patchId: string, opts: { actorId?: string } = {}): Promise<WikiPatch> {
    const db = getDb();
    const patch = await this.getPatch(patchId);
    if (!patch) throw new Error(`WikiPatch not found: ${patchId}`);

    const now = new Date().toISOString();
    await db.update(wikiPatches).set({
      status: 'dismissed',
      decidedBy: opts.actorId ?? null,
      decidedAt: now,
      updatedAt: now,
    }).where(eq(wikiPatches.id, patchId));

    return (await this.getPatch(patchId))!;
  },
};
