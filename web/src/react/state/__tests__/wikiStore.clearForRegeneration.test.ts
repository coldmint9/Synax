import { describe, it, expect, beforeEach } from 'vitest';
import { useWikiStore } from '../wikiStore';

describe('useWikiStore.clearForRegeneration', () => {
  beforeEach(() => {
    useWikiStore.getState().reset();
    useWikiStore.setState({
      snapshot: {
        id: 'snap-1',
        projectId: 'proj-1',
        branch: 'main',
        headCommitSha: 'abc',
        workingTreeHash: 'wth',
        repoIndexId: null,
        revision: 1,
        status: 'ready',
        documentIds: ['doc-1'],
        createdAt: '2026-01-01',
        createdBy: 'agent',
      },
      documents: [{
        id: 'doc-1',
        snapshotId: 'snap-1',
        projectId: 'proj-1',
        title: 'Doc',
        docType: 'module',
        parentId: null,
        contentMd: '# Doc',
        references: [],
        pipelineStage: 'drafted',
        sortOrder: 0,
        manualState: 'none',
        staleState: 'fresh',
        isSection: false,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      }],
      draftPanelOpen: true,
      loading: { snapshot: true, plans: false, drafts: false },
    });
  });

  it('clears wiki content without enabling snapshot skeleton loading', () => {
    useWikiStore.getState().clearForRegeneration();
    const state = useWikiStore.getState();

    expect(state.snapshot).toBeNull();
    expect(state.documents).toEqual([]);
    expect(state.draftPanelOpen).toBe(false);
    expect(state.loading.snapshot).toBe(false);
    expect(state.refreshTask.phase).toBe('idle');
  });
});
