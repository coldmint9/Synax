// ---------------------------------------------------------------------------
// api/services/wiki/wiki-draft-service.ts
//
// Document-level refresh drafts: apply, edit, discard, expire
// ---------------------------------------------------------------------------

import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiRefreshDrafts } from '../../db/schema.js';
import { wikiStore, WikiManualProtectionError } from './wiki-store.js';
import type { WikiRefreshDraft, DraftDocumentChange } from './contracts.js';

function rowToDraft(r: typeof wikiRefreshDrafts.$inferSelect): WikiRefreshDraft {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    refreshTaskId: r.refreshTaskId ?? null,
    documentId: r.documentId,
    status: r.status as WikiRefreshDraft['status'],
    changes: JSON.parse(r.changesJson) as DraftDocumentChange[],
    summary: r.summary ?? null,
    sourceCommitSha: r.sourceCommitSha ?? null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? null,
    decidedAt: r.decidedAt ?? null,
    decidedBy: r.decidedBy ?? null,
  };
}

export interface ApplyResult {
  applied: string[];
  conflicts: Array<{ documentId: string; manualState: string }>;
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
    const documentIds = draft.changes.map(c => c.documentId);
    return this._applyChanges(draft, documentIds, opts);
  },

  async applyPartial(
    draftId: string,
    documentIds: string[],
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.status !== 'ready' && draft.status !== 'partially_applied') {
      throw new Error(`Draft ${draftId} is not in ready/partially_applied state`);
    }
    return this._applyChanges(draft, documentIds, opts);
  },

  async editAndApply(
    draftId: string,
    edits: Array<{ documentId: string; newContentMd: string }>,
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const db = getDb();
    const draft = await this.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.status !== 'ready' && draft.status !== 'partially_applied') {
      throw new Error(`Draft ${draftId} is not in ready/partially_applied state`);
    }

    const updatedChanges = draft.changes.map(change => {
      const edit = edits.find(e => e.documentId === change.documentId);
      if (edit) return { ...change, newContentMd: edit.newContentMd };
      return change;
    });

    await db.update(wikiRefreshDrafts).set({
      changesJson: JSON.stringify(updatedChanges),
    }).where(eq(wikiRefreshDrafts.id, draftId));

    const documentIds = edits.map(e => e.documentId);
    const freshDraft = (await this.getDraft(draftId))!;
    return this._applyChanges(freshDraft, documentIds, opts);
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
    documentIds: string[],
    opts: { actorId?: string; confirmManualOverride?: boolean } = {},
  ): Promise<ApplyResult> {
    const db = getDb();
    const now = new Date().toISOString();
    const applied: string[] = [];
    const conflicts: Array<{ documentId: string; manualState: string }> = [];

    for (const documentId of documentIds) {
      const change = draft.changes.find(c => c.documentId === documentId);
      if (!change) continue;

      const doc = await wikiStore.getDocument(documentId);
      if (!doc) continue;

      if (doc.manualState !== 'none' && !opts.confirmManualOverride) {
        conflicts.push({ documentId, manualState: doc.manualState });
        continue;
      }

      if (change.newContentMd == null) continue;

      try {
        await wikiStore.updateDocumentContent(documentId, {
          contentMd: change.newContentMd,
          manualState: opts.confirmManualOverride ? 'edited' : undefined,
          actorId: opts.actorId,
        });
        applied.push(documentId);
      } catch (err) {
        if (err instanceof WikiManualProtectionError) {
          conflicts.push({ documentId, manualState: err.manualState });
        } else {
          throw err;
        }
      }
    }

    const allDocumentIds = draft.changes.map(c => c.documentId);
    const allApplied = allDocumentIds.every(id => applied.includes(id));
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
