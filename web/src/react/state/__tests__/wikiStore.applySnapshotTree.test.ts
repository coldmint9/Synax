import { describe, it, expect, beforeEach } from 'vitest';
import { useWikiStore } from '../wikiStore';
import type { WikiDocument } from '../../../lib/contracts/wiki';

function makeDoc(partial: Partial<WikiDocument> & Pick<WikiDocument, 'id' | 'title'>): WikiDocument {
  return {
    snapshotId: 'snap-1',
    projectId: 'proj-1',
    docType: 'module',
    sortOrder: 0,
    parentId: null,
    contentMd: '# body',
    references: [],
    pipelineStage: 'done',
    manualState: 'none',
    staleState: 'fresh',
    isSection: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('useWikiStore.applySnapshotTree', () => {
  beforeEach(() => {
    useWikiStore.getState().reset();
  });

  it('updates documents when only parentId hierarchy changes', () => {
    useWikiStore.setState({
      documents: [
        makeDoc({ id: 'sec', title: 'Core', isSection: true }),
        makeDoc({ id: 'page', title: 'Module A', parentId: null }),
      ],
    });

    useWikiStore.getState().applySnapshotTree({
      snapshot: null,
      documents: [
        makeDoc({ id: 'sec', title: 'Core', isSection: true }),
        makeDoc({ id: 'page', title: 'Module A', parentId: 'sec' }),
      ],
      draftsSummary: { ready: 0, generating: 0 },
    });

    expect(useWikiStore.getState().documents.find(d => d.id === 'page')?.parentId).toBe('sec');
  });

  it('compares documents by id instead of array index', () => {
    useWikiStore.setState({
      documents: [
        makeDoc({ id: 'b', title: 'Second', sortOrder: 2 }),
        makeDoc({ id: 'a', title: 'First', sortOrder: 1 }),
      ],
    });

    useWikiStore.getState().applySnapshotTree({
      snapshot: null,
      documents: [
        makeDoc({ id: 'a', title: 'First', sortOrder: 1, parentId: 'root' }),
        makeDoc({ id: 'b', title: 'Second', sortOrder: 2, parentId: 'root' }),
        makeDoc({ id: 'root', title: 'Overview', isSection: true, sortOrder: 0 }),
      ],
      draftsSummary: { ready: 0, generating: 0 },
    });

    const docs = useWikiStore.getState().documents;
    expect(docs).toHaveLength(3);
    expect(docs.find(d => d.id === 'a')?.parentId).toBe('root');
    expect(docs.find(d => d.id === 'b')?.parentId).toBe('root');
  });
});
