// ---------------------------------------------------------------------------
// api/services/wiki/wiki-coordinate-service.ts
//
// CodeIndex/SourceLink → WikiSourceBinding + wiki_source_block_index
// 持久化 file_path/range/qualified_name，支持 hash-diff stale check
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiSourceBindings, wikiSourceBlockIndex } from '../../db/schema.js';
import type { CodeIndex, SourceLink, FileEntry, SymbolEntry, ChunkEntry } from '../contracts/forest.js';
import type { WikiSourceBinding, WikiSourcePrecision, WikiSourceType } from './contracts.js';

export interface CoordinateResolution {
  resolved: boolean;
  binding?: WikiSourceBinding;
  precision: WikiSourcePrecision;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  qualifiedName?: string;
  ideUri?: string;
  fallbackSearchQuery?: string;
}

export interface SourceLocator {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  qualifiedName?: string;
  hash: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function precisionFromSourceLink(link: SourceLink): WikiSourcePrecision {
  switch (link.anchor.kind) {
    case 'symbol': return 'symbol';
    case 'chunk': return 'chunk';
    case 'file': return 'file';
    case 'concept': return 'file';
    default: return 'file';
  }
}

function sourceTypeFromAnchor(kind: string): WikiSourceType {
  switch (kind) {
    case 'symbol': return 'symbol';
    case 'chunk': return 'chunk';
    case 'file': return 'file';
    case 'concept': return 'semantic_node';
    default: return 'file';
  }
}

function sourceIdFromLink(link: SourceLink): string {
  const a = link.anchor;
  if (a.kind === 'symbol') return a.symbolId;
  if (a.kind === 'chunk') return a.chunkId;
  if (a.kind === 'file') return a.fileId;
  if (a.kind === 'concept') return a.semanticNodeId;
  return link.id;
}

function symbolFingerprint(sym: SymbolEntry): string {
  return createHash('sha256')
    .update(`${sym.qualifiedName}|${sym.kind}|${sym.signature ?? ''}|${sym.range.startLine}-${sym.range.endLine}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build a SourceLocator (file path + range + hash) for a SourceLink, using the codeIndex.
 * Returns null if anchor cannot be resolved in the index.
 */
export function buildLocator(link: SourceLink, codeIndex: CodeIndex): SourceLocator | null {
  const a = link.anchor;
  if (a.kind === 'file') {
    const file = codeIndex.files.find(f => f.id === a.fileId);
    if (!file) return null;
    return { filePath: file.path, hash: file.sha };
  }
  if (a.kind === 'symbol') {
    const sym = codeIndex.symbols.find(s => s.id === a.symbolId);
    if (!sym) return null;
    const file = codeIndex.files.find(f => f.id === sym.fileId);
    return {
      filePath: file?.path,
      startLine: sym.range.startLine,
      endLine: sym.range.endLine,
      qualifiedName: sym.qualifiedName,
      hash: symbolFingerprint(sym),
    };
  }
  if (a.kind === 'chunk') {
    const chunk = codeIndex.chunks.find(c => c.id === a.chunkId);
    if (!chunk) return null;
    const file = codeIndex.files.find(f => f.id === chunk.fileId);
    return {
      filePath: file?.path,
      startLine: chunk.range.startLine,
      endLine: chunk.range.endLine,
      hash: chunk.hash,
    };
  }
  return { hash: link.id };
}

/**
 * Compute the current hash for a stored source binding by looking up the source in a fresh codeIndex.
 * Returns null if the source has been removed (i.e. "stale by deletion").
 */
function currentHashForBinding(
  binding: { sourceType: string; sourceId: string },
  codeIndex: CodeIndex,
): string | null {
  if (binding.sourceType === 'file') {
    const file = codeIndex.files.find(f => f.id === binding.sourceId);
    return file?.sha ?? null;
  }
  if (binding.sourceType === 'symbol') {
    const sym = codeIndex.symbols.find(s => s.id === binding.sourceId);
    return sym ? symbolFingerprint(sym) : null;
  }
  if (binding.sourceType === 'chunk') {
    const chunk = codeIndex.chunks.find(c => c.id === binding.sourceId);
    return chunk?.hash ?? null;
  }
  return null;
}

// ── Row mapper ───────────────────────────────────────────────────────────────

function rowToBinding(r: typeof wikiSourceBindings.$inferSelect): WikiSourceBinding {
  return {
    id: r.id,
    projectId: r.projectId,
    wikiBlockId: r.wikiBlockId,
    sourceType: r.sourceType as WikiSourceBinding['sourceType'],
    sourceId: r.sourceId,
    lastVerifiedRepoIndexId: r.lastVerifiedRepoIndexId ?? null,
    lastVerifiedHash: r.lastVerifiedHash ?? null,
    precision: r.precision as WikiSourcePrecision,
    confidence: r.confidence,
    filePath: r.filePath ?? null,
    startLine: r.startLine ?? null,
    endLine: r.endLine ?? null,
    createdBy: r.createdBy as WikiSourceBinding['createdBy'],
    createdAt: r.createdAt,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

export const wikiCoordinateService = {
  async createBindingsFromLinks(
    projectId: string,
    repoIndexId: string,
    blockLinkMap: Array<{ blockId: string; links: SourceLink[] }>,
    codeIndex: CodeIndex,
  ): Promise<WikiSourceBinding[]> {
    const db = getDb();
    const now = new Date().toISOString();
    const created: WikiSourceBinding[] = [];

    for (const { blockId, links } of blockLinkMap) {
      for (const link of links) {
        const locator = buildLocator(link, codeIndex);
        if (!locator) continue;

        const id = nanoid();
        const sourceId = sourceIdFromLink(link);
        const precision = precisionFromSourceLink(link);
        const sourceType = sourceTypeFromAnchor(link.anchor.kind);

        await db.insert(wikiSourceBindings).values({
          id,
          projectId,
          wikiBlockId: blockId,
          sourceType,
          sourceId,
          lastVerifiedRepoIndexId: repoIndexId,
          lastVerifiedHash: locator.hash,
          precision,
          confidence: link.confidence,
          createdBy: link.createdBy === 'human' ? 'human' : link.createdBy === 'agent' ? 'agent' : 'analyzer',
          createdAt: now,
          filePath: locator.filePath ?? null,
          startLine: locator.startLine ?? null,
          endLine: locator.endLine ?? null,
          qualifiedName: locator.qualifiedName ?? null,
        }).onConflictDoNothing();

        created.push({
          id,
          projectId,
          wikiBlockId: blockId,
          sourceType,
          sourceId,
          lastVerifiedRepoIndexId: repoIndexId,
          lastVerifiedHash: locator.hash,
          precision,
          confidence: link.confidence,
          filePath: locator.filePath ?? null,
          startLine: locator.startLine ?? null,
          endLine: locator.endLine ?? null,
          createdBy: 'analyzer',
          createdAt: now,
        });
      }
    }

    await this.rebuildSourceBlockIndex(projectId, repoIndexId, created);
    return created;
  },

  async rebuildSourceBlockIndex(
    projectId: string,
    repoIndexId: string,
    bindings: WikiSourceBinding[],
  ): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();

    const bySource = new Map<string, string[]>();
    for (const b of bindings) {
      const existing = bySource.get(b.sourceId) ?? [];
      if (!existing.includes(b.wikiBlockId)) existing.push(b.wikiBlockId);
      bySource.set(b.sourceId, existing);
    }

    for (const [sourceId, blockIds] of bySource) {
      await db
        .insert(wikiSourceBlockIndex)
        .values({
          projectId,
          repoIndexId,
          sourceId,
          wikiBlockIdsJson: JSON.stringify(blockIds),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            wikiSourceBlockIndex.projectId,
            wikiSourceBlockIndex.repoIndexId,
            wikiSourceBlockIndex.sourceId,
          ],
          set: { wikiBlockIdsJson: JSON.stringify(blockIds), updatedAt: now },
        });
    }
  },

  /**
   * Resolve a binding ID to its persisted locator. No code scan required.
   */
  async resolveBinding(bindingId: string): Promise<CoordinateResolution> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSourceBindings)
      .where(eq(wikiSourceBindings.id, bindingId))
      .limit(1);

    if (!rows[0]) return { resolved: false, precision: 'file' };

    const r = rows[0];
    const precision = r.precision as WikiSourcePrecision;
    const filePath = r.filePath ?? undefined;
    const startLine = r.startLine ?? undefined;
    const endLine = r.endLine ?? undefined;

    const ideUri = filePath
      ? startLine
        ? `vscode://file/${filePath}:${startLine}`
        : `vscode://file/${filePath}`
      : undefined;

    return {
      resolved: Boolean(filePath),
      binding: rowToBinding(r),
      precision,
      filePath,
      startLine,
      endLine,
      qualifiedName: r.qualifiedName ?? undefined,
      ideUri,
      fallbackSearchQuery: r.qualifiedName ?? filePath ?? undefined,
    };
  },

  /**
   * Hash-diff stale check. Returns the set of binding IDs whose source has
   * actually changed (or been removed) compared to a fresh codeIndex.
   */
  async detectChangedBindings(
    projectId: string,
    codeIndex: CodeIndex,
  ): Promise<{ changedBindingIds: string[]; changedSourceIds: string[] }> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSourceBindings)
      .where(eq(wikiSourceBindings.projectId, projectId));

    const changedBindingIds: string[] = [];
    const changedSourceIds = new Set<string>();

    for (const r of rows) {
      const currentHash = currentHashForBinding(
        { sourceType: r.sourceType, sourceId: r.sourceId },
        codeIndex,
      );
      // Removed source OR hash mismatch → changed
      if (currentHash === null || (r.lastVerifiedHash && currentHash !== r.lastVerifiedHash)) {
        changedBindingIds.push(r.id);
        changedSourceIds.add(r.sourceId);
      }
    }

    return { changedBindingIds, changedSourceIds: [...changedSourceIds] };
  },

  /**
   * Update lastVerifiedHash on bindings whose source was unchanged (cheap freshness markers).
   */
  async refreshVerifiedHashes(
    projectId: string,
    repoIndexId: string,
    codeIndex: CodeIndex,
  ): Promise<number> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiSourceBindings)
      .where(eq(wikiSourceBindings.projectId, projectId));

    let count = 0;
    for (const r of rows) {
      const currentHash = currentHashForBinding(
        { sourceType: r.sourceType, sourceId: r.sourceId },
        codeIndex,
      );
      if (currentHash === null || currentHash === r.lastVerifiedHash) continue;
      // Hash changed but we're not marking stale here — that's the caller's job.
      // We only verify unchanged ones — skip.
    }

    // Mark verified for unchanged bindings
    for (const r of rows) {
      const currentHash = currentHashForBinding(
        { sourceType: r.sourceType, sourceId: r.sourceId },
        codeIndex,
      );
      if (currentHash !== null && currentHash === r.lastVerifiedHash) {
        await db.update(wikiSourceBindings).set({
          lastVerifiedRepoIndexId: repoIndexId,
        }).where(eq(wikiSourceBindings.id, r.id));
        count++;
      }
    }
    return count;
  },

  async getBlockIdsBySourceIds(
    projectId: string,
    repoIndexId: string,
    sourceIds: string[],
  ): Promise<Map<string, string[]>> {
    const db = getDb();
    const result = new Map<string, string[]>();
    if (sourceIds.length === 0) return result;

    const rows = await db
      .select()
      .from(wikiSourceBlockIndex)
      .where(
        and(
          eq(wikiSourceBlockIndex.projectId, projectId),
          eq(wikiSourceBlockIndex.repoIndexId, repoIndexId),
          inArray(wikiSourceBlockIndex.sourceId, sourceIds),
        ),
      );

    for (const r of rows) {
      result.set(r.sourceId, JSON.parse(r.wikiBlockIdsJson) as string[]);
    }
    return result;
  },

  async getBlockIdsByBindingIds(bindingIds: string[]): Promise<string[]> {
    if (bindingIds.length === 0) return [];
    const db = getDb();
    const rows = await db
      .select({ wikiBlockId: wikiSourceBindings.wikiBlockId })
      .from(wikiSourceBindings)
      .where(inArray(wikiSourceBindings.id, bindingIds));
    return [...new Set(rows.map(r => r.wikiBlockId))];
  },
};
