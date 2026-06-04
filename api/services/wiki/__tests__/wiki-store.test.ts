// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-store.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockLimit = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhere = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere, orderBy: mockOrderBy }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate, onConflictDoNothing: mockOnConflictDoNothing }));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSetWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockSetWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

const mockDb = { select: mockSelect, insert: mockInsert, update: mockUpdate };

vi.mock('../../../db/index.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../db/schema.js', () => ({
  wikiSnapshots: { id: 'id', projectId: 'project_id', revision: 'revision' },
  wikiDocuments: { id: 'id', snapshotId: 'snapshot_id', sortOrder: 'sort_order' },
  wikiBlocks: { id: 'id', documentId: 'document_id', projectId: 'project_id' },
  wikiBlockRevisions: { blockId: 'block_id', revision: 'revision' },
  wikiSourceBindings: { id: 'id', wikiBlockId: 'wiki_block_id', projectId: 'project_id' },
  wikiPatches: { id: 'id', projectId: 'project_id', status: 'status' },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

import { wikiStore, WikiManualProtectionError } from '../wiki-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-1', projectId: 'proj-1', branch: 'main',
    headCommitSha: 'abc123', workingTreeHash: 'wth1', repoIndexId: null,
    revision: 1, status: 'ready', documentIdsJson: '[]',
    createdAt: '2026-01-01', createdBy: 'agent', ...overrides,
  };
}

function makeBlockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'block-1', projectId: 'proj-1', documentId: 'doc-1',
    blockType: 'prose', contentJson: '{"text":"hello"}',
    contentFormat: 'rich_text_json', sourceBindingIdsJson: '[]',
    contentHash: 'abc', generatedFromHash: null,
    staleState: 'fresh', manualState: 'none', confidence: 0.8,
    generatedByJson: '{}', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('wikiStore.getLatestSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no rows', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const result = await wikiStore.getLatestSnapshot('proj-1');
    expect(result).toBeNull();
  });

  it('maps row to WikiSnapshot domain object', async () => {
    mockLimit.mockResolvedValueOnce([makeSnapshotRow()]);
    const result = await wikiStore.getLatestSnapshot('proj-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('snap-1');
    expect(result!.branch).toBe('main');
    expect(result!.documentIds).toEqual([]);
    expect(result!.status).toBe('ready');
  });
});

describe('wikiStore.getBlock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when not found', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const result = await wikiStore.getBlock('missing');
    expect(result).toBeNull();
  });

  it('parses content JSON', async () => {
    mockLimit.mockResolvedValueOnce([makeBlockRow()]);
    const result = await wikiStore.getBlock('block-1');
    expect(result).not.toBeNull();
    expect(result!.content).toEqual({ text: 'hello' });
    expect(result!.blockType).toBe('prose');
  });
});

describe('wikiStore.updateBlockContent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes contentHash as sha256 of content', async () => {
    // getBlock call
    mockLimit.mockResolvedValueOnce([makeBlockRow()]);
    // revision query
    mockLimit.mockResolvedValueOnce([{ revision: 1 }]);
    // final getBlock
    mockLimit.mockResolvedValueOnce([makeBlockRow({ manualState: 'edited' })]);

    await wikiStore.updateBlockContent('block-1', { content: { text: 'updated' }, actorId: 'user-1' });

    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ text: 'updated' }))
      .digest('hex')
      .slice(0, 32);

    // The update call should have been made with the correct hash
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: expectedHash }),
    );
  });

  it('sets manualState to edited by default', async () => {
    mockLimit.mockResolvedValueOnce([makeBlockRow()]);
    mockLimit.mockResolvedValueOnce([]);
    mockLimit.mockResolvedValueOnce([makeBlockRow({ manualState: 'edited' })]);

    await wikiStore.updateBlockContent('block-1', { content: { text: 'x' } });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ manualState: 'edited' }),
    );
  });

  it('respects explicit manualState=locked', async () => {
    mockLimit.mockResolvedValueOnce([makeBlockRow()]);
    mockLimit.mockResolvedValueOnce([]);
    mockLimit.mockResolvedValueOnce([makeBlockRow({ manualState: 'locked' })]);

    await wikiStore.updateBlockContent('block-1', { content: { text: 'x' }, manualState: 'locked' });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ manualState: 'locked' }),
    );
  });

  it('throws when block not found', async () => {
    mockLimit.mockResolvedValueOnce([]);
    await expect(
      wikiStore.updateBlockContent('missing', { content: {} }),
    ).rejects.toThrow('WikiBlock not found');
  });
});

describe('wikiStore.upsertBlock — manual protection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws WikiManualProtectionError when updating a manually-edited block', async () => {
    // getBlock returns a block with manualState=edited
    mockLimit.mockResolvedValueOnce([makeBlockRow({ manualState: 'edited' })]);

    await expect(
      wikiStore.upsertBlock({
        id: 'block-1',
        projectId: 'proj-1',
        documentId: 'doc-1',
        blockType: 'prose',
        content: { text: 'overwrite' },
      }),
    ).rejects.toThrow(WikiManualProtectionError);
  });

  it('allows upsert when manualState=none (new block, no id)', async () => {
    // No getBlock call for new blocks (no id provided)
    // insert().values() returns object with onConflictDoUpdate
    mockOnConflictDoUpdate.mockResolvedValueOnce(undefined);
    mockLimit.mockResolvedValueOnce([makeBlockRow()]);

    const result = await wikiStore.upsertBlock({
      projectId: 'proj-1',
      documentId: 'doc-1',
      blockType: 'prose',
      content: { text: 'ok' },
    });
    expect(result.id).toBe('block-1');
  });
});

describe('wikiStore.markBlocksStale', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op for empty array', async () => {
    await wikiStore.markBlocksStale([], 'stale');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('calls update with correct staleState', async () => {
    await wikiStore.markBlocksStale(['block-1', 'block-2'], 'possibly_stale');
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ staleState: 'possibly_stale' }),
    );
  });
});
