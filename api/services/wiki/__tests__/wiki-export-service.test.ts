import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WikiDocument } from '../contracts.js';

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getSnapshotTree: vi.fn(),
    getDocument: vi.fn(),
    getSnapshot: vi.fn(),
  },
}));

import { wikiExportService } from '../wiki-export-service.js';
import { wikiStore } from '../wiki-store.js';

function makeDoc(overrides: Partial<WikiDocument> = {}): WikiDocument {
  return {
    id: 'doc-1',
    snapshotId: 'snap-1',
    projectId: 'proj-1',
    title: 'Overview',
    docType: 'landscape',
    parentId: null,
    contentMd: '# Overview\n\nSome content.',
    references: [{ filePath: 'src/index.ts' }],
    pipelineStage: 'done',
    sortOrder: 0,
    manualState: 'none',
    staleState: 'fresh',
    isSection: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('wikiExportService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exportSnapshot joins document markdown', async () => {
    vi.mocked(wikiStore.getSnapshotTree).mockResolvedValueOnce({
      snapshot: {
        id: 'snap-1', projectId: 'proj-1', branch: 'main', headCommitSha: 'abc',
        workingTreeHash: 'w', repoIndexId: null, revision: 1, status: 'ready',
        documentIds: ['doc-1'], createdAt: '2026-01-01', createdBy: 'system',
      },
      documents: [makeDoc()],
      draftsSummary: { ready: 0, generating: 0 },
    });

    const result = await wikiExportService.exportSnapshot('snap-1');
    expect(result.content).toContain('# Overview');
    expect(result.fileName).toContain('wiki-proj-1-r1');
  });

  it('exportDocument appends references when includeSourceRefs', async () => {
    vi.mocked(wikiStore.getDocument).mockResolvedValueOnce(makeDoc());
    vi.mocked(wikiStore.getSnapshot).mockResolvedValueOnce({
      id: 'snap-1', projectId: 'proj-1', branch: 'main', headCommitSha: 'abc',
      workingTreeHash: 'w', repoIndexId: null, revision: 1, status: 'ready',
      documentIds: ['doc-1'], createdAt: '2026-01-01', createdBy: 'system',
    });

    const result = await wikiExportService.exportDocument('doc-1', { includeSourceRefs: true });
    expect(result.content).toContain('## References');
    expect(result.content).toContain('src/index.ts');
  });
});
