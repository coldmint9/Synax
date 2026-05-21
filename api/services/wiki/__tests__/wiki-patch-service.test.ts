// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-patch-service.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock DB
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

const mockDb = {
  select: mockSelect.mockReturnThis(),
  from: mockFrom.mockReturnThis(),
  where: mockWhere.mockReturnThis(),
  limit: mockLimit,
  orderBy: mockOrderBy.mockReturnValue({ limit: mockLimit }),
  insert: mockInsert.mockReturnThis(),
  values: mockValues.mockResolvedValue(undefined),
  update: mockUpdate.mockReturnThis(),
  set: mockSet.mockReturnThis(),
};
mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

vi.mock('../../../db/index.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../db/schema.js', () => ({
  wikiPatches: { id: 'id' },
  wikiBlocks: { id: 'id', documentId: 'document_id' },
  wikiBlockRevisions: { blockId: 'block_id', revision: 'revision' },
}));

const mockGetBlock = vi.fn();
const mockMarkBlocksStale = vi.fn();
vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getBlock: (...args: unknown[]) => mockGetBlock(...args),
    markBlocksStale: (...args: unknown[]) => mockMarkBlocksStale(...args),
  },
}));

import { wikiPatchService, WikiPatchConflictError } from '../wiki-patch-service.js';

function makePatchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patch-1',
    projectId: 'proj-1',
    snapshotId: 'snap-1',
    refreshTaskId: null,
    agentSessionId: null,
    targetDocumentId: 'doc-1',
    targetBlockIdsJson: '["block-1"]',
    kind: 'update',
    status: 'pending',
    risk: 'low',
    confidence: 0.8,
    oldContentJson: '{"text":"old"}',
    newContentJson: '{"text":"new"}',
    sourceDiffIdsJson: '[]',
    reasoningJson: '["reason"]',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

describe('wikiPatchService.accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws WikiPatchConflictError when block has manualState=edited', async () => {
    mockLimit.mockResolvedValueOnce([makePatchRow()]);
    mockGetBlock.mockResolvedValueOnce({
      id: 'block-1',
      manualState: 'edited',
      projectId: 'proj-1',
    });

    await expect(
      wikiPatchService.accept('patch-1', {}),
    ).rejects.toThrow(WikiPatchConflictError);
  });

  it('throws WikiPatchConflictError when block has manualState=locked', async () => {
    mockLimit.mockResolvedValueOnce([makePatchRow()]);
    mockGetBlock.mockResolvedValueOnce({
      id: 'block-1',
      manualState: 'locked',
      projectId: 'proj-1',
    });

    await expect(
      wikiPatchService.accept('patch-1', {}),
    ).rejects.toThrow(WikiPatchConflictError);
  });

  it('succeeds with confirmManualOverride=true even when block is edited', async () => {
    mockLimit
      .mockResolvedValueOnce([makePatchRow()])  // getPatch
      .mockResolvedValueOnce([{ revision: 2 }]); // revision query
    mockGetBlock
      .mockResolvedValueOnce({ id: 'block-1', manualState: 'edited', projectId: 'proj-1' })
      .mockResolvedValueOnce({ id: 'block-1', manualState: 'edited', projectId: 'proj-1' });

    // Final getPatch after accept
    mockLimit.mockResolvedValueOnce([makePatchRow({ status: 'accepted' })]);

    const result = await wikiPatchService.accept('patch-1', { confirmManualOverride: true });
    expect(result.status).toBe('accepted');
  });

  it('succeeds for block with manualState=none without override', async () => {
    mockLimit
      .mockResolvedValueOnce([makePatchRow()])  // getPatch
      .mockResolvedValueOnce([{ revision: 1 }]); // revision query
    mockGetBlock
      .mockResolvedValueOnce({ id: 'block-1', manualState: 'none', projectId: 'proj-1' })
      .mockResolvedValueOnce({ id: 'block-1', manualState: 'none', projectId: 'proj-1' });

    mockLimit.mockResolvedValueOnce([makePatchRow({ status: 'accepted' })]);

    const result = await wikiPatchService.accept('patch-1', {});
    expect(result.status).toBe('accepted');
  });
});
