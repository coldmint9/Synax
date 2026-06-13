// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-store.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLimit = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhere = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere, orderBy: mockOrderBy }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockSetWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockSetWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

const mockDb = { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete };

vi.mock('../../../db/index.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../db/schema.js', () => ({
  wikiSnapshots: { id: 'id', projectId: 'project_id', revision: 'revision', status: 'status' },
  wikiDocuments: { id: 'id', snapshotId: 'snapshot_id', sortOrder: 'sort_order', projectId: 'project_id' },
  wikiRefreshTasks: { projectId: 'project_id' },
  wikiRefreshDrafts: { projectId: 'project_id', status: 'status' },
  wikiPlans: { projectId: 'project_id', status: 'status' },
  wikiPlanNodes: {},
  wikiPlanNodeArtifacts: {},
  wikiEvaluations: { projectId: 'project_id' },
  wikiWriteBatches: { snapshotId: 'snapshot_id', status: 'status' },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'test-id' }));
vi.mock('../wiki-fts.js', () => ({ extractSearchText: (md: string) => md.replace(/#/g, '') }));
vi.mock('../wiki-project-locks.js', () => ({
  isProjectReinitializing: vi.fn(() => false),
}));

import { wikiStore, WikiManualProtectionError } from '../wiki-store.js';
import { isProjectReinitializing } from '../wiki-project-locks.js';

function makeSnapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-1', projectId: 'proj-1', branch: 'main',
    headCommitSha: 'abc123', workingTreeHash: 'wth1', repoIndexId: null,
    revision: 1, status: 'ready', documentIdsJson: '[]',
    createdAt: '2026-01-01', createdBy: 'agent', ...overrides,
  };
}

function makeDocumentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1', snapshotId: 'snap-1', projectId: 'proj-1',
    title: 'Overview', docType: 'landscape', parentId: null,
    contentMd: '# Overview\n\nBody text', referencesJson: '[{"filePath":"a.ts"}]',
    searchText: 'Overview Body text', pipelineStage: 'drafted',
    sortOrder: 0, manualState: 'none', staleState: 'fresh',
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('wikiStore.getLatestSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no rows', async () => {
    mockLimit.mockResolvedValueOnce([]);
    expect(await wikiStore.getLatestSnapshot('proj-1')).toBeNull();
  });

  it('maps row to WikiSnapshot domain object', async () => {
    mockLimit.mockResolvedValueOnce([makeSnapshotRow()]);
    const result = await wikiStore.getLatestSnapshot('proj-1');
    expect(result?.id).toBe('snap-1');
    expect(result?.documentIds).toEqual([]);
  });
});

describe('wikiStore.hasActiveGeneration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns active when latest snapshot is writing', async () => {
    mockLimit.mockResolvedValueOnce([makeSnapshotRow({ id: 'snap-writing', status: 'writing' })]);
    await expect(wikiStore.hasActiveGeneration('proj-1')).resolves.toEqual({
      active: true,
      snapshotId: 'snap-writing',
      status: 'writing',
    });
  });

  it('returns inactive when latest snapshot is ready', async () => {
    mockLimit.mockResolvedValueOnce([makeSnapshotRow({ status: 'ready' })]);
    await expect(wikiStore.hasActiveGeneration('proj-1')).resolves.toEqual({ active: false });
  });

  it('returns active when project is reinitializing', async () => {
    vi.mocked(isProjectReinitializing).mockReturnValueOnce(true);
    await expect(wikiStore.hasActiveGeneration('proj-1')).resolves.toEqual({
      active: true,
      status: 'reinitializing',
    });
  });
});

describe('wikiStore.getDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses contentMd and references', async () => {
    mockLimit.mockResolvedValueOnce([makeDocumentRow()]);
    const result = await wikiStore.getDocument('doc-1');
    expect(result?.contentMd).toContain('Overview');
    expect(result?.references[0]?.filePath).toBe('a.ts');
  });
});

describe('wikiStore.updateDocumentContent — manual protection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws WikiManualProtectionError when document is locked', async () => {
    mockLimit.mockResolvedValueOnce([makeDocumentRow({ manualState: 'locked' })]);
    await expect(
      wikiStore.updateDocumentContent('doc-1', { contentMd: 'new' }),
    ).rejects.toThrow(WikiManualProtectionError);
  });
});

describe('wikiStore.markDocumentsStale', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op for empty array', async () => {
    await wikiStore.markDocumentsStale([], 'stale');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('wikiStore.recoverOrphanedSnapshots', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks refreshing snapshots as failed', async () => {
    mockSetWhere.mockResolvedValueOnce({ rowsAffected: 1 });
    mockWhere.mockResolvedValueOnce([]);

    const count = await wikiStore.recoverOrphanedSnapshots();

    expect(count).toBe(1);
    expect(mockSet).toHaveBeenCalledWith({ status: 'failed' });
  });

  it('restores writing snapshots to outline_ready when no content was written', async () => {
    mockSetWhere.mockResolvedValueOnce({ rowsAffected: 0 });
    mockWhere.mockResolvedValueOnce([
      makeSnapshotRow({ id: 'snap-writing', status: 'writing' }),
    ]);
    mockWhere.mockResolvedValueOnce([]);
    mockOrderBy.mockResolvedValueOnce([
      makeDocumentRow({ id: 'doc-1', contentMd: '', pipelineStage: 'pending' }),
    ]);
    mockSetWhere.mockResolvedValueOnce(undefined);

    const count = await wikiStore.recoverOrphanedSnapshots();

    expect(count).toBe(1);
    expect(mockSet).toHaveBeenCalledWith({ status: 'outline_ready' });
  });
});
