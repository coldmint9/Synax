// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-patch-service-content-hash.test.ts
// Tests for contentHash fix in wiki-patch-service accept()
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockLimit = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhere = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSetWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockSetWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

const mockDb = { select: mockSelect, insert: mockInsert, update: mockUpdate };

vi.mock('../../../db/index.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../db/schema.js', () => ({
  wikiPatches: { id: 'id' },
  wikiBlocks: { id: 'id' },
  wikiBlockRevisions: { blockId: 'block_id', revision: 'revision' },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'rev-id' }));

const mockGetBlock = vi.fn();
const mockMarkBlocksStale = vi.fn();
vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getBlock: (...args: unknown[]) => mockGetBlock(...args),
    markBlocksStale: (...args: unknown[]) => mockMarkBlocksStale(...args),
  },
}));

import { wikiPatchService } from '../wiki-patch-service.js';

function makePatchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patch-1', projectId: 'proj-1', snapshotId: 'snap-1',
    refreshTaskId: null, agentSessionId: null,
    targetDocumentId: 'doc-1', targetBlockIdsJson: '["block-1"]',
    kind: 'update', status: 'pending', risk: 'low', confidence: 0.8,
    oldContentJson: '{"text":"old"}', newContentJson: '{"text":"new content here"}',
    sourceDiffIdsJson: '[]', reasoningJson: '["reason"]',
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    decidedBy: null, decidedAt: null, ...overrides,
  };
}

describe('wikiPatchService.accept — contentHash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes non-empty contentHash (sha256 of newContent) to revision row', async () => {
    // getPatch
    mockLimit.mockResolvedValueOnce([makePatchRow()]);
    // getBlock (manual protection check)
    mockGetBlock.mockResolvedValueOnce({ id: 'block-1', manualState: 'none', projectId: 'proj-1' });
    // getBlock (apply patch)
    mockGetBlock.mockResolvedValueOnce({ id: 'block-1', manualState: 'none', projectId: 'proj-1' });
    // revision query
    mockLimit.mockResolvedValueOnce([{ revision: 2 }]);
    // final getPatch
    mockLimit.mockResolvedValueOnce([makePatchRow({ status: 'accepted' })]);

    await wikiPatchService.accept('patch-1', {});

    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ text: 'new content here' }))
      .digest('hex')
      .slice(0, 32);

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: expectedHash }),
    );
    // Ensure it's not empty string
    expect(expectedHash).not.toBe('');
    expect(expectedHash.length).toBe(32);
  });

  it('dismiss does not write any revision row', async () => {
    mockLimit.mockResolvedValueOnce([makePatchRow()]);
    mockLimit.mockResolvedValueOnce([makePatchRow({ status: 'dismissed' })]);

    await wikiPatchService.dismiss('patch-1', {});

    // insert should not have been called for revisions
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
