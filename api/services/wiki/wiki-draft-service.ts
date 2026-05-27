// ---------------------------------------------------------------------------
// api/services/wiki/wiki-draft-service.ts
//
// Document-level refresh drafts: apply, partial-apply, edit, discard, expire
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { wikiRefreshDrafts, wikiBlocks, wikiBlockRevisions } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import type { WikiRefreshDraft, DraftBlockChange } from './contracts.js';

function rowToDraft(r: typeof wikiRefreshDrafts.$inferSelect): WikiRefreshDraft {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    refreshTaskId: r.refreshTaskId ?? null,
    documentId: r.documentId,
    status: r.status as WikiRefreshDraft['status'],
    changes: JSON.parse(r.changesJson) as DraftBlockChange[],
    summary: r.summary ?? null,
    aggregateRisk: r.aggregateRisk as WikiRefreshDraft['aggregateRisk'],
    aggregateConfidence: r.aggregateConfidence,
    sourceCommitSha: r.sourceCommitSha ?? null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? null,
    decidedAt: r.decidedAt ?? null,
    decidedBy: r.decidedBy ?? null,
  };
}

export interface ApplyResult {
  applied: string[];
  conflicts: Array<{ blockId: string; manualState: string }>;
}

export const wikiDraftService = {
  async getDraft(draftId: string): Promise<WikiRefreshDraft | null> {
    const db = getDb();
    const rows = await db.select().from(wikiRefreshDrafts)
      .where(eq(wikiRefreshDrafts.id, draftId)).limit(1);
    return rows[0] ? rowToDraft(rows[0]) : null;
  },

  async getDraftsByProject(projectId: string, status?: string): Promise<WikiRefreshDraft[]> {
    const db = getDb();
    const conditions = [eq(wikiRefreshDrafts.projectId, projectId)];
    if (status) conditions.push(eq(wikiRefreshDrafts.status, status));
    const rows = await db.select().from(wikiRefreshDrafts)
      .where(and(...conditions))
      .orderBy(desc(wikiRefreshDrafts.createdAt));
    return rows.map(rowToDraft);
  },

  async applyDraft(
    draftId: string,
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.status !== 'ready' && draft.status !== 'partially_applied') {
      throw new Error(`Draft ${draftId} is not in ready/partially_applied state (current: ${draft.status})`);
    }
    const blockIds = draft.changes
      .filter(c => c.action !== 'insert_after')
      .map(c => c.blockId);
    return this._applyChanges(draft, blockIds, opts);
  },

  async applyPartial(
    draftId: string,
    blockIds: string[],
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.status !== 'ready' && draft.status !== 'partially_applied') {
      throw new Error(`Draft ${draftId} is not in ready/partially_applied state`);
    }
    return this._applyChanges(draft, blockIds, opts);
  },

  async editAndApply(
    draftId: string,
    edits: Array<{ blockId: string; newContent: unknown }>,
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const db = getDb();
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.status !== 'ready' && draft.status !== 'partially_applied') {
      throw new Error(`Draft ${draftId} is not in ready/partially_applied state`);
    }

    const updatedChanges = draft.changes.map(change => {
      const edit = edits.find(e => e.blockId === change.blockId);
      if (edit) return { ...change, newContent: edit.newContent };
      return change;
    });

    await db.update(wikiRefreshDrafts).set({
      changesJson: JSON.stringify(updatedChanges),
    }).where(eq(wikiRefreshDrafts.id, draftId));

    const blockIds = edits.map(e => e.blockId);
    const freshDraft = (await this.getDraft(draftId))!;
    return this._applyChanges(freshDraft, blockIds, opts);
  },

  async discardDraft(draftId: string, opts: { actorId?: string } = {}): Promise<WikiRefreshDraft> {
    const db = getDb();
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    const now = new Date().toISOString();
    await db.update(wikiRefreshDrafts).set({
      status: 'discarded',
      decidedBy: opts.actorId ?? null,
      decidedAt: now,
    }).where(eq(wikiRefreshDrafts.id, draftId));
    return (await this.getDraft(draftId))!;
  },

  async expireDraft(draftId: string): Promise<void> {
    const db = getDb();
    await db.update(wikiRefreshDrafts).set({ status: 'expired' })
      .where(eq(wikiRefreshDrafts.id, draftId));
  },

  async checkFreshness(draftId: string, currentSha: string): Promise<boolean> {
    const draft = await this.getDraft(draftId);
    if (!draft) return false;
    if (!draft.sourceCommitSha) return true;
    if (draft.sourceCommitSha !== currentSha) {
      await this.expireDraft(draftId);
      return false;
    }
    return true;
  },

  async _applyChanges(
    draft: WikiRefreshDraft,
    blockIds: string[],
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const db = getDb();
    const now = new Date().toISOString();
    const applied: string[] = [];
    const conflicts: Array<{ blockId: string; manualState: string }> = [];

    for (const blockId of blockIds) {
      const change = draft.changes.find(c => c.blockId === blockId);
      if (!change) continue;

      const block = await wikiStore.getBlock(blockId);
      if (!block) continue;

      if (block.manualState !== 'none' && !opts.confirmManualOverride) {
        conflicts.push({ blockId, manualState: block.manualState });
        continue;
      }

      if (change.action === 'delete') {
        await wikiStore.markBlocksStale([blockId], 'stale');
        applied.push(blockId);
        continue;
      }

      await db.update(wikiBlocks).set({
        contentJson: JSON.stringify(change.newContent),
        staleState: 'fresh',
        updatedAt: now,
      }).where(eq(wikiBlocks.id, blockId));

      const revisions = await db.select().from(wikiBlockRevisions)
        .where(eq(wikiBlockRevisions.blockId, blockId))
        .orderBy(desc(wikiBlockRevisions.revision))
        .limit(1);
      const nextRevision = (revisions[0]?.revision ?? 0) + 1;
      const contentHash = createHash('sha256')
        .update(JSON.stringify(change.newContent))
        .digest('hex')
        .slice(0, 32);

      await db.insert(wikiBlockRevisions).values({
        id: nanoid(),
        projectId: draft.projectId,
        blockId,
        revision: nextRevision,
        contentJson: JSON.stringify(change.newContent),
        contentHash,
        source: 'draft',
        draftId: draft.id,
        createdAt: now,
        createdBy: opts.actorId ?? null,
      });

      applied.push(blockId);
    }

    const allBlockIds = draft.changes.map(c => c.blockId);
    const allApplied = allBlockIds.every(id => applied.includes(id));
    const newStatus = allApplied ? 'applied'
      : applied.length > 0 ? 'partially_applied'
      : draft.status;

    await db.update(wikiRefreshDrafts).set({
      status: newStatus,
      decidedBy: opts.actorId ?? null,
      decidedAt: now,
    }).where(eq(wikiRefreshDrafts.id, draft.id));

    return { applied, conflicts };
  },
};
