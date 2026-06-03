// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-export-service.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({ select: mockSelect }) }));
vi.mock('../../../db/schema.js', () => ({
  wikiDocuments: { id: 'id', snapshotId: 'snapshot_id' },
  wikiBlocks: { id: 'id', documentId: 'document_id' },
}));

const mockGetSnapshotTree = vi.fn();
const mockGetSnapshot = vi.fn();
vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getSnapshotTree: (...args: unknown[]) => mockGetSnapshotTree(...args),
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
  },
}));

import { wikiExportService } from '../wiki-export-service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-1', projectId: 'proj-1', branch: 'main',
    headCommitSha: 'abc', workingTreeHash: 'wth', repoIndexId: null,
    revision: 3, status: 'ready', documentIds: ['doc-1'],
    createdAt: '2026-01-01', createdBy: 'agent', ...overrides,
  };
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1', snapshotId: 'snap-1', projectId: 'proj-1',
    title: 'Overview', docType: 'overview', parentId: null,
    blockIds: ['block-1', 'block-2'], sortOrder: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides,
  };
}

function makeBlock(id: string, blockType: string, content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id, projectId: 'proj-1', documentId: 'doc-1',
    blockType, content, contentFormat: 'rich_text_json',
    sourceBindingIds: [], contentHash: 'h', generatedFromHash: null,
    staleState: 'fresh', manualState: 'none', confidence: 0.9,
    generatedBy: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('wikiExportService.exportSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when snapshot not found', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce(null);
    await expect(wikiExportService.exportSnapshot('missing')).rejects.toThrow('WikiSnapshot not found');
  });

  it('returns correct fileName with revision', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc()],
      blocks: [
        makeBlock('block-1', 'heading', { level: 2, text: 'Architecture' }),
        makeBlock('block-2', 'paragraph', { text: 'This is the overview.' }),
      ],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.fileName).toBe('wiki-proj-1-r3.md');
    expect(result.snapshotId).toBe('snap-1');
    expect(result.revision).toBe(3);
  });

  it('renders heading block as markdown heading', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc()],
      blocks: [makeBlock('block-1', 'heading', { level: 2, text: 'My Section' })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.content).toContain('## My Section');
  });

  it('renders paragraph block as plain text', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc({ blockIds: ['block-1'] })],
      blocks: [makeBlock('block-1', 'paragraph', { text: 'Hello world.' })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.content).toContain('Hello world.');
  });

  it('renders list block as markdown list', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc({ blockIds: ['block-1'] })],
      blocks: [makeBlock('block-1', 'list', { items: ['Item A', 'Item B'], ordered: false })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.content).toContain('- Item A');
    expect(result.content).toContain('- Item B');
  });

  it('renders table block as markdown table', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc({ blockIds: ['block-1'] })],
      blocks: [makeBlock('block-1', 'table', {
        headers: ['Name', 'Type'],
        rows: [['foo', 'string'], ['bar', 'number']],
      })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.content).toContain('| Name | Type |');
    expect(result.content).toContain('| foo | string |');
  });

  it('includes source binding comments when includeSourceRefs=true', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc({ blockIds: ['block-1'] })],
      blocks: [makeBlock('block-1', 'paragraph', { text: 'Text.' }, { sourceBindingIds: ['bind-1'] })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1', { includeSourceRefs: true });
    expect(result.content).toContain('<!-- bindings: bind-1 -->');
  });

  it('does not include binding comments when includeSourceRefs=false', async () => {
    mockGetSnapshotTree.mockResolvedValueOnce({
      snapshot: makeSnapshot(),
      documents: [makeDoc({ blockIds: ['block-1'] })],
      blocks: [makeBlock('block-1', 'paragraph', { text: 'Text.' }, { sourceBindingIds: ['bind-1'] })],
      sourceBindings: [],
      patchesSummary: { pending: 0, conflict: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1', { includeSourceRefs: false });
    expect(result.content).not.toContain('<!-- bindings:');
  });
});
