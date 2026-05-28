// ---------------------------------------------------------------------------
// api/services/wiki/wiki-store.ts — Wiki 专用存储层
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { eq, desc, and, inArray, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import {
  wikiSnapshots,
  wikiDocuments,
  wikiBlocks,
  wikiBlockRevisions,
  wikiSourceBindings,
  wikiPatches,
  wikiRefreshTasks,
  wikiRefreshDrafts,
  wikiDesignMappingTasks,
  wikiPlans,
  wikiPlanNodes,
  wikiPlanNodeArtifacts,
  wikiEvaluations,
} from '../../db/schema.js';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiBlock,
  WikiBlockRevision,
  WikiSourceBinding,
  WikiPatch,
  WikiSnapshotTree,
  CreateWikiSnapshotInput,
  UpsertWikiDocumentInput,
  UpsertWikiBlockInput,
  UpdateBlockContentInput,
  WikiStaleState,
} from './contracts.js';

export class WikiManualProtectionError extends Error {
  constructor(public readonly blockId: string, public readonly manualState: string) {
    super(`Block ${blockId} has manualState=${manualState}; refusing to overwrite. Use patch flow with confirmManualOverride.`);
    this.name = 'WikiManualProtectionError';
  }
}

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
    blockIds: JSON.parse(r.blockIdsJson) as string[],
    sortOrder: r.sortOrder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToBlock(r: typeof wikiBlocks.$inferSelect): WikiBlock {
  return {
    id: r.id,
    projectId: r.projectId,
    documentId: r.documentId,
    blockType: r.blockType as WikiBlock['blockType'],
    content: JSON.parse(r.contentJson),
    contentFormat: r.contentFormat as WikiBlock['contentFormat'],
    sourceBindingIds: JSON.parse(r.sourceBindingIdsJson) as string[],
    contentHash: r.contentHash,
    generatedFromHash: r.generatedFromHash ?? null,
    staleState: r.staleState as WikiBlock['staleState'],
    manualState: r.manualState as WikiBlock['manualState'],
    confidence: r.confidence,
    generatedBy: JSON.parse(r.generatedByJson) as WikiBlock['generatedBy'],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToBinding(r: typeof wikiSourceBindings.$inferSelect): WikiSourceBinding {
  return {
    id: r.id,
    projectId: r.projectId,
    wikiBlockId: r.wikiBlockId,
    sourceType: r.sourceType as WikiSourceBinding['sourceType'],
    sourceId: r.sourceId,
    lastVerifiedRepoIndexId: r.lastVerifiedRepoIndexId ?? null,
    lastVerifiedHash: r.lastVerifiedHash ?? null,
    precision: r.precision as WikiSourceBinding['precision'],
    confidence: r.confidence,
    filePath: r.filePath ?? null,
    startLine: r.startLine ?? null,
    endLine: r.endLine ?? null,
    createdBy: r.createdBy as WikiSourceBinding['createdBy'],
    createdAt: r.createdAt,
  };
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
    const result = await db
      .update(wikiSnapshots)
      .set({ status: 'failed' })
      .where(inArray(wikiSnapshots.status, ['refreshing', 'outline_ready', 'writing']));
    return result.rowsAffected ?? 0;
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
    await db
      .insert(wikiDocuments)
      .values({
        id,
        snapshotId: input.snapshotId,
        projectId: input.projectId,
        title: input.title,
        docType: input.docType,
        parentId: input.parentId ?? null,
        blockIdsJson: JSON.stringify(input.blockIds ?? []),
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: wikiDocuments.id,
        set: {
          title: input.title,
          docType: input.docType,
          parentId: input.parentId ?? null,
          blockIdsJson: JSON.stringify(input.blockIds ?? []),
          sortOrder: input.sortOrder ?? 0,
          updatedAt: now,
        },
      });
    const rows = await db.select().from(wikiDocuments).where(eq(wikiDocuments.id, id)).limit(1);
    return rowToDocument(rows[0]);
  },

  async updateDocumentBlockIds(documentId: string, blockIds: string[]): Promise<void> {
    const db = getDb();
    await db
      .update(wikiDocuments)
      .set({ blockIdsJson: JSON.stringify(blockIds), updatedAt: new Date().toISOString() })
      .where(eq(wikiDocuments.id, documentId));
  },

  // ── Blocks ────────────────────────────────────────────────────────────────

  async getBlocksByDocument(documentId: string): Promise<WikiBlock[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiBlocks)
      .where(eq(wikiBlocks.documentId, documentId));
    return rows.map(rowToBlock);
  },

  async getBlock(blockId: string): Promise<WikiBlock | null> {
    const db = getDb();
    const rows = await db.select().from(wikiBlocks).where(eq(wikiBlocks.id, blockId)).limit(1);
    return rows[0] ? rowToBlock(rows[0]) : null;
  },

  async upsertBlock(input: UpsertWikiBlockInput): Promise<WikiBlock> {
    const db = getDb();
    const now = new Date().toISOString();
    const id = input.id ?? nanoid();
    const contentJson = JSON.stringify(input.content);

    // Manual protection: if updating an existing block with manualState != 'none',
    // refuse to overwrite. Callers must route the change through the patch flow.
    if (input.id) {
      const existing = await this.getBlock(input.id);
      if (existing && existing.manualState !== 'none') {
        throw new WikiManualProtectionError(input.id, existing.manualState);
      }
    }

    await db
      .insert(wikiBlocks)
      .values({
        id,
        projectId: input.projectId,
        documentId: input.documentId,
        blockType: input.blockType,
        contentJson,
        contentFormat: input.contentFormat ?? 'markdown_fragment',
        sourceBindingIdsJson: JSON.stringify(input.sourceBindingIds ?? []),
        contentHash: input.contentHash ?? '',
        generatedFromHash: input.generatedFromHash ?? null,
        staleState: input.staleState ?? 'fresh',
        manualState: input.manualState ?? 'none',
        confidence: input.confidence ?? 0.5,
        generatedByJson: JSON.stringify(input.generatedBy ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: wikiBlocks.id,
        set: {
          contentJson,
          contentFormat: input.contentFormat ?? 'markdown_fragment',
          sourceBindingIdsJson: JSON.stringify(input.sourceBindingIds ?? []),
          contentHash: input.contentHash ?? '',
          generatedFromHash: input.generatedFromHash ?? null,
          staleState: input.staleState ?? 'fresh',
          confidence: input.confidence ?? 0.5,
          generatedByJson: JSON.stringify(input.generatedBy ?? {}),
          updatedAt: now,
        },
      });
    return (await this.getBlock(id))!;
  },

  async updateBlockContent(blockId: string, input: UpdateBlockContentInput): Promise<WikiBlock> {
    const db = getDb();
    const block = await this.getBlock(blockId);
    if (!block) throw new Error(`WikiBlock not found: ${blockId}`);

    const now = new Date().toISOString();
    const contentJson = JSON.stringify(input.content);
    const contentHash = createHash('sha256')
      .update(contentJson)
      .digest('hex')
      .slice(0, 32);

    await db.update(wikiBlocks).set({
      contentJson,
      contentHash,
      manualState: input.manualState ?? 'edited',
      updatedAt: now,
    }).where(eq(wikiBlocks.id, blockId));

    // Write revision
    const revisions = await db
      .select()
      .from(wikiBlockRevisions)
      .where(eq(wikiBlockRevisions.blockId, blockId))
      .orderBy(desc(wikiBlockRevisions.revision))
      .limit(1);
    const nextRevision = (revisions[0]?.revision ?? 0) + 1;
    await db.insert(wikiBlockRevisions).values({
      id: nanoid(),
      projectId: block.projectId,
      blockId,
      revision: nextRevision,
      contentJson,
      contentHash,
      source: 'human',
      patchId: null,
      createdAt: now,
      createdBy: input.actorId ?? null,
    });

    return (await this.getBlock(blockId))!;
  },

  async markBlocksStale(blockIds: string[], staleState: WikiStaleState): Promise<void> {
    if (blockIds.length === 0) return;
    const db = getDb();
    await db
      .update(wikiBlocks)
      .set({ staleState, updatedAt: new Date().toISOString() })
      .where(inArray(wikiBlocks.id, blockIds));
  },

  // ── Source Bindings ───────────────────────────────────────────────────────

  async appendBindingIds(blockId: string, newIds: string[]): Promise<void> {
    const db = getDb();
    const block = await this.getBlock(blockId);
    if (!block) return;
    const merged = [...new Set([...block.sourceBindingIds, ...newIds])];
    await db
      .update(wikiBlocks)
      .set({ sourceBindingIdsJson: JSON.stringify(merged), updatedAt: new Date().toISOString() })
      .where(eq(wikiBlocks.id, blockId));
  },

  async getBindingsByBlock(blockId: string): Promise<WikiSourceBinding[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSourceBindings)
      .where(eq(wikiSourceBindings.wikiBlockId, blockId));
    return rows.map(rowToBinding);
  },

  async getBindingsBySnapshot(snapshotId: string): Promise<WikiSourceBinding[]> {
    const db = getDb();
    // Single query: bindings JOIN blocks JOIN documents WHERE snapshot
    const rows = await db
      .select({ binding: wikiSourceBindings })
      .from(wikiSourceBindings)
      .innerJoin(wikiBlocks, eq(wikiSourceBindings.wikiBlockId, wikiBlocks.id))
      .innerJoin(wikiDocuments, eq(wikiBlocks.documentId, wikiDocuments.id))
      .where(eq(wikiDocuments.snapshotId, snapshotId));
    return rows.map(r => rowToBinding(r.binding));
  },

  // ── Patches ───────────────────────────────────────────────────────────────

  async getPatchesByProject(
    projectId: string,
    status?: WikiPatch['status'],
  ): Promise<WikiPatch[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiPatches)
      .where(
        status
          ? and(eq(wikiPatches.projectId, projectId), eq(wikiPatches.status, status))
          : eq(wikiPatches.projectId, projectId),
      )
      .orderBy(desc(wikiPatches.createdAt));
    return rows.map(rowToPatch);
  },

  // ── Snapshot Tree ─────────────────────────────────────────────────────────

  async getSnapshotTree(snapshotId: string): Promise<WikiSnapshotTree | null> {
    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot) return null;

    const documents = await this.getDocumentsBySnapshot(snapshotId);
    const docIds = documents.map(d => d.id);

    let blocks: WikiBlock[] = [];
    if (docIds.length > 0) {
      const db = getDb();
      const rows = await db
        .select()
        .from(wikiBlocks)
        .where(inArray(wikiBlocks.documentId, docIds));
      blocks = rows.map(rowToBlock);
    }

    const sourceBindings = await this.getBindingsBySnapshot(snapshotId);

    const patches = await this.getPatchesByProject(snapshot.projectId);
    const patchesSummary = {
      pending: patches.filter(p => p.status === 'pending').length,
      conflict: patches.filter(p => p.status === 'conflict').length,
    };

    const db2 = getDb();
    const draftRows = await db2.select().from(wikiRefreshDrafts)
      .where(eq(wikiRefreshDrafts.projectId, snapshot.projectId));
    const draftsSummary = {
      ready: draftRows.filter(r => r.status === 'ready').length,
      generating: draftRows.filter(r => r.status === 'generating').length,
    };

    return { snapshot, documents, blocks, sourceBindings, patchesSummary, draftsSummary };
  },

  async purgeProject(projectId: string): Promise<void> {
    const db = getDb();
    await db.delete(wikiSourceBindings).where(eq(wikiSourceBindings.projectId, projectId));
    await db.delete(wikiBlockRevisions).where(eq(wikiBlockRevisions.projectId, projectId));
    await db.delete(wikiBlocks).where(eq(wikiBlocks.projectId, projectId));
    await db.delete(wikiPatches).where(eq(wikiPatches.projectId, projectId));
    await db.delete(wikiDocuments).where(eq(wikiDocuments.projectId, projectId));
    await db.delete(wikiRefreshTasks).where(eq(wikiRefreshTasks.projectId, projectId));
    await db.delete(wikiDesignMappingTasks).where(eq(wikiDesignMappingTasks.projectId, projectId));
    await db.delete(wikiSnapshots).where(eq(wikiSnapshots.projectId, projectId));

    // 清空所有 drafts
    await db.delete(wikiRefreshDrafts).where(eq(wikiRefreshDrafts.projectId, projectId));

    // 归档未完结的 plans（设为 discarded）
    const terminalStatuses = ['completed', 'discarded'];
    await db.update(wikiPlans)
      .set({ status: 'discarded', updatedAt: new Date().toISOString() })
      .where(and(
        eq(wikiPlans.projectId, projectId),
        notInArray(wikiPlans.status, terminalStatuses),
      ));

    // 清理关联的 evaluations（引用的 block 已被删除）
    await db.delete(wikiEvaluations).where(eq(wikiEvaluations.projectId, projectId));
  },

  async deleteDocumentsBySnapshot(snapshotId: string): Promise<void> {
    const db = getDb();
    const docs = await db.select({ id: wikiDocuments.id }).from(wikiDocuments)
      .where(eq(wikiDocuments.snapshotId, snapshotId));
    if (docs.length === 0) return;
    const docIds = docs.map(d => d.id);
    await db.delete(wikiSourceBindings).where(inArray(wikiSourceBindings.wikiBlockId,
      db.select({ id: wikiBlocks.id }).from(wikiBlocks).where(inArray(wikiBlocks.documentId, docIds))
    ));
    await db.delete(wikiBlockRevisions).where(inArray(wikiBlockRevisions.blockId,
      db.select({ id: wikiBlocks.id }).from(wikiBlocks).where(inArray(wikiBlocks.documentId, docIds))
    ));
    await db.delete(wikiBlocks).where(inArray(wikiBlocks.documentId, docIds));
    await db.delete(wikiDocuments).where(inArray(wikiDocuments.id, docIds));
  },
};
