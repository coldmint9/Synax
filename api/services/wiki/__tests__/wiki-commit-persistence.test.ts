import { describe, expect, it, vi, beforeEach } from 'vitest';
import { findExistingDocId, persistWikiDocumentCommit } from '../wiki-commit-persistence.js';
import type { WikiOutlineEntry } from '../tools/contracts.js';

const mockGetDocument = vi.fn();
const mockUpdateDocumentContent = vi.fn();

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getDocument: (...args: unknown[]) => mockGetDocument(...args),
    updateDocumentContent: (...args: unknown[]) => mockUpdateDocumentContent(...args),
    getDocumentsBySnapshot: vi.fn(),
    upsertDocument: vi.fn(),
  },
}));

describe('findExistingDocId', () => {
  const outline: WikiOutlineEntry[] = [
    { id: 'plan-root', docType: 'landscape', title: 'Overview', sortOrder: 0, targetFiles: [], keyQuestions: [] },
    {
      id: 'plan-child',
      docType: 'module',
      title: 'Auth Module',
      parentId: 'plan-root',
      sortOrder: 1,
      targetFiles: [],
      keyQuestions: [],
    },
  ];

  const planIdToDocId = new Map([
    ['plan-root', 'doc-root'],
    ['plan-child', 'doc-child'],
  ]);

  it('resolves root document by title and docType', () => {
    expect(findExistingDocId(
      { title: 'Overview', docType: 'landscape' },
      outline,
      planIdToDocId,
    )).toBe('doc-root');
  });

  it('resolves child document even when parentPlanId is set', () => {
    expect(findExistingDocId(
      { title: 'Auth Module', docType: 'module' },
      outline,
      planIdToDocId,
    )).toBe('doc-child');
  });

  it('returns null when outline entry is missing', () => {
    expect(findExistingDocId(
      { title: 'Missing', docType: 'module' },
      outline,
      planIdToDocId,
    )).toBeNull();
  });
});

describe('persistWikiDocumentCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fills the target skeleton document when targetDocumentId is provided', async () => {
    mockGetDocument.mockResolvedValue({
      id: 'doc-child',
      snapshotId: 'snap-1',
      title: 'Auth Module',
      docType: 'module',
    });
    mockUpdateDocumentContent.mockResolvedValue(undefined);

    const docId = await persistWikiDocumentCommit({
      draft: {
        title: 'Renamed By Model',
        docType: 'module',
        markdown: '# Body',
        references: [],
      },
      snapshotId: 'snap-1',
      projectId: 'proj-1',
      outline: null,
      planIdToDocId: new Map(),
      targetDocumentId: 'doc-child',
    });

    expect(docId).toBe('doc-child');
    expect(mockUpdateDocumentContent).toHaveBeenCalledWith('doc-child', {
      contentMd: '# Body',
      references: [],
    });
  });
});
