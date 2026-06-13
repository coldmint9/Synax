// ---------------------------------------------------------------------------
// api/services/wiki/wiki-store.ts — Wiki 专用存储层
// ---------------------------------------------------------------------------

import { eq, desc, and, inArray, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import {
  wikiSnapshots,
  wikiDocuments,
  wikiRefreshTasks,
  wikiRefreshDrafts,
  wikiPlans,
  wikiPlanNodes,
  wikiPlanNodeArtifacts,
  wikiEvaluations,
  wikiWriteBatches,
} from '../../db/schema.js';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiSnapshotTree,
  WikiReference,
  CreateWikiSnapshotInput,
  UpsertWikiDocumentInput,
  UpdateDocumentContentInput,
  WikiStaleState,
} from './contracts.js';
import { WikiManualProtectionError } from './contracts.js';
import { extractSearchText } from './wiki-fts.js';

export { WikiManualProtectionError };

// ── Row → Domain mappers ─────────────────────────────────────────────────────

function rowToSnapshot(r: typeof wikiSnapshots.$inferSelect): WikiSnapshot {
  return {
    id: r.id,
    projectId: r.projectId,
    branch: r.branch,
    headCommitSha: r.headCommitSha,
    workingTreeHash: r.workingTreeHash,
    repoIndexId: r.repoIndexId ?? null,
    revision: r.revision,
    status: r.status as WikiSnapshot['status'],
    documentIds: JSON.parse(r.documentIdsJson) as string[],
    createdAt: r.createdAt,
    createdBy: r.createdBy as WikiSnapshot['createdBy'],
  };
}

function rowToDocument(r: typeof wikiDocuments.$inferSelect): WikiDocument {
  return {
    id: r.id,
    snapshotId: r.snapshotId,
    projectId: r.projectId,
    title: r.title,
    docType: r.docType as WikiDocument['docType'],
    parentId: r.parentId ?? null,
    contentMd: r.contentMd,
    references: JSON.parse(r.referencesJson) as WikiReference[],
    pipelineStage: (r.pipelineStage ?? 'pending') as WikiDocument['pipelineStage'],
    sortOrder: r.sortOrder,
    manualState: r.manualState as WikiDocument['manualState'],
    staleState: r.staleState as WikiDocument['staleState'],
    isSection: Boolean(r.isSection),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── WikiStore ────────────────────────────────────────────────────────────────

export const wikiStore = {
  // ── Snapshot ──────────────────────────────────────────────────────────────

  async getLatestSnapshot(projectId: string): Promise<WikiSnapshot | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSnapshots)
      .where(eq(wikiSnapshots.projectId, projectId))
      .orderBy(desc(wikiSnapshots.revision))
      .limit(1);
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  },

  async hasActiveGeneration(projectId: string): Promise<{
    active: boolean;
    snapshotId?: string;
    status?: WikiSnapshot['status'];
  }> {
    const latest = await this.getLatestSnapshot(projectId);
    if (!latest) return { active: false };
    if (latest.status === 'refreshing' || latest.status === 'writing') {
      return { active: true, snapshotId: latest.id, status: latest.status };
    }
    return { active: false };
  },

  async getSnapshot(snapshotId: string): Promise<WikiSnapshot | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSnapshots)
      .where(eq(wikiSnapshots.id, snapshotId))
      .limit(1);
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  },

  async createSnapshot(input: CreateWikiSnapshotInput): Promise<WikiSnapshot> {
    const db = getDb();
    const latest = await this.getLatestSnapshot(input.projectId);
    const revision = (latest?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    const id = nanoid();
    await db.insert(wikiSnapshots).values({
      id,
      projectId: input.projectId,
      branch: input.branch,
      headCommitSha: input.headCommitSha,
      workingTreeHash: input.workingTreeHash,
      repoIndexId: input.repoIndexId ?? null,
      revision,
      status: 'ready',
      documentIdsJson: '[]',
      createdAt: now,
      createdBy: input.createdBy ?? 'system',
    });
    return (await this.getSnapshot(id))!;
  },

  async updateSnapshotStatus(
    snapshotId: string,
    status: WikiSnapshot['status'],
    documentIds?: string[],
  ): Promise<void> {
    const db = getDb();
    const updates: Partial<typeof wikiSnapshots.$inferInsert> = { status };
    if (documentIds !== undefined) {
      updates.documentIdsJson = JSON.stringify(documentIds);
    }
    await db.update(wikiSnapshots).set(updates).where(eq(wikiSnapshots.id, snapshotId));
  },

  async recoverOrphanedSnapshots(): Promise<number> {
    const db = getDb();

    const refreshingResult = await db
      .update(wikiSnapshots)
      .set({ status: 'failed' })
      .where(eq(wikiSnapshots.status, 'refreshing'));

    const writingSnapshots = await db
      .select()
      .from(wikiSnapshots)
      .where(eq(wikiSnapshots.status, 'writing'));

    let writingRecovered = 0;
    for (const row of writingSnapshots) {
      const activeBatches = await db
        .select()
        .from(wikiWriteBatches)
        .where(and(
          eq(wikiWriteBatches.snapshotId, row.id),
          eq(wikiWriteBatches.status, 'running'),
        ));
      if (activeBatches.length > 0) {
        continue;
      }

      const docs = await this.getDocumentsBySnapshot(row.id);
      const hasWrittenContent = docs.some(
        (doc) => !doc.isSection && doc.contentMd.trim().length > 0,
      );
      await db
        .update(wikiSnapshots)
        .set({ status: hasWrittenContent ? 'failed' : 'outline_ready' })
        .where(eq(wikiSnapshots.id, row.id));
      writingRecovered++;
    }

    return Number(refreshingResult.rowsAffected ?? 0) + writingRecovered;
  },

  // ── Documents ─────────────────────────────────────────────────────────────

  async getDocumentsBySnapshot(snapshotId: string): Promise<WikiDocument[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiDocuments)
      .where(eq(wikiDocuments.snapshotId, snapshotId))
      .orderBy(wikiDocuments.sortOrder);
    return rows.map(rowToDocument);
  },

  async getDocument(documentId: string): Promise<WikiDocument | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiDocuments)
      .where(eq(wikiDocuments.id, documentId))
      .limit(1);
    return rows[0] ? rowToDocument(rows[0]) : null;
  },

  async upsertDocument(input: UpsertWikiDocumentInput): Promise<WikiDocument> {
    const db = getDb();
    const now = new Date().toISOString();
    const id = input.id ?? nanoid();
    const contentMd = input.contentMd ?? '';
    const referencesJson = JSON.stringify(input.references ?? []);
    const searchText = extractSearchText(contentMd);

    await db
      .insert(wikiDocuments)
      .values({
        id,
        snapshotId: input.snapshotId,
        projectId: input.projectId,
        title: input.title,
        docType: input.docType,
        parentId: input.parentId ?? null,
        contentMd,
        referencesJson,
        searchText,
        pipelineStage: input.pipelineStage ?? 'pending',
        sortOrder: input.sortOrder ?? 0,
        manualState: input.manualState ?? 'none',
        staleState: input.staleState ?? 'fresh',
        isSection: input.isSection ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: wikiDocuments.id,
        set: {
          title: input.title,
          docType: input.docType,
          parentId: input.parentId ?? null,
          contentMd: input.contentMd ?? undefined,
          referencesJson: input.references !== undefined ? referencesJson : undefined,
          searchText: input.contentMd !== undefined ? searchText : undefined,
          pipelineStage: input.pipelineStage ?? undefined,
          sortOrder: input.sortOrder ?? 0,
          manualState: input.manualState ?? undefined,
          staleState: input.staleState ?? undefined,
          isSection: input.isSection !== undefined ? (input.isSection ? 1 : 0) : undefined,
          updatedAt: now,
        },
      });
    const rows = await db.select().from(wikiDocuments).where(eq(wikiDocuments.id, id)).limit(1);
    return rowToDocument(rows[0]);
  },

  async updateDocumentContent(documentId: string, input: UpdateDocumentContentInput): Promise<WikiDocument> {
    const db = getDb();
    const existing = await this.getDocument(documentId);
    if (!existing) throw new Error(`WikiDocument not found: ${documentId}`);

    if (existing.manualState !== 'none' && input.manualState === undefined) {
      throw new WikiManualProtectionError(documentId, existing.manualState);
    }

    const now = new Date().toISOString();
    const referencesJson = input.references !== undefined
      ? JSON.stringify(input.references)
      : undefined;
    const searchText = extractSearchText(input.contentMd);

    await db.update(wikiDocuments).set({
      contentMd: input.contentMd,
      ...(referencesJson !== undefined ? { referencesJson } : {}),
      searchText,
      manualState: input.manualState ?? existing.manualState,
      updatedAt: now,
    }).where(eq(wikiDocuments.id, documentId));

    return (await this.getDocument(documentId))!;
  },

  async updateDocumentPipelineStage(documentId: string, stage: 'pending' | 'drafted' | 'verified' | 'corrected' | 'done'): Promise<void> {
    const db = getDb();
    await db
      .update(wikiDocuments)
      .set({ pipelineStage: stage, updatedAt: new Date().toISOString() })
      .where(eq(wikiDocuments.id, documentId));
  },

  async markDocumentsStale(documentIds: string[], staleState: WikiStaleState): Promise<void> {
    if (documentIds.length === 0) return;
    const db = getDb();
    await db
      .update(wikiDocuments)
      .set({ staleState, updatedAt: new Date().toISOString() })
      .where(inArray(wikiDocuments.id, documentIds));
  },

  // ── Snapshot Tree ─────────────────────────────────────────────────────────

  async getSnapshotTree(snapshotId: string): Promise<WikiSnapshotTree | null> {
    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot) return null;

    const documents = await this.getDocumentsBySnapshot(snapshotId);

    const db = getDb();
    const draftRows = await db.select().from(wikiRefreshDrafts)
      .where(eq(wikiRefreshDrafts.projectId, snapshot.projectId));
    const draftsSummary = {
      ready: draftRows.filter(r => r.status === 'ready').length,
      generating: draftRows.filter(r => r.status === 'generating').length,
    };

    return { snapshot, documents, draftsSummary };
  },

  async purgeProject(projectId: string): Promise<void> {
    const db = getDb();
    await db.delete(wikiDocuments).where(eq(wikiDocuments.projectId, projectId));
    await db.delete(wikiRefreshTasks).where(eq(wikiRefreshTasks.projectId, projectId));
    await db.delete(wikiSnapshots).where(eq(wikiSnapshots.projectId, projectId));
    await db.delete(wikiRefreshDrafts).where(eq(wikiRefreshDrafts.projectId, projectId));

    const terminalStatuses = ['completed', 'discarded'];
    await db.update(wikiPlans)
      .set({ status: 'discarded', updatedAt: new Date().toISOString() })
      .where(and(
        eq(wikiPlans.projectId, projectId),
        notInArray(wikiPlans.status, terminalStatuses),
      ));

    await db.delete(wikiEvaluations).where(eq(wikiEvaluations.projectId, projectId));
  },

  async deleteDocumentsBySnapshot(snapshotId: string): Promise<void> {
    const db = getDb();
    await db.delete(wikiDocuments).where(eq(wikiDocuments.snapshotId, snapshotId));
  },
};
