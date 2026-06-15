import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockTryGetSession = vi.fn();
const mockGetSession = vi.fn();

vi.mock('../../agent-runtime/session-store.js', () => ({
  agentRuntimeStore: {
    tryGetSession: (...args: unknown[]) => mockTryGetSession(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    updateDocumentPipelineStage: vi.fn(),
  },
}));
vi.mock('../wiki-snapshot-events.js', () => ({
  publishDocumentCommittedEvent: vi.fn(),
}));
vi.mock('../wiki-commit-persistence.js', () => ({
  persistWikiDocumentCommit: vi.fn(),
  toCommitInput: vi.fn(),
}));

import { wikiSessionToolProvider } from '../wiki-session-tool-provider.js';

describe('wikiSessionToolProvider.getTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wikiSessionToolProvider.clearSessionTools('ars_test');
  });

  it('returns per-session commit and mermaid tools for document-writer', () => {
    mockTryGetSession.mockReturnValue({
      sessionMetadata: { snapshotId: 'snap-1', phase: 'document-writer' },
    });

    const tools = wikiSessionToolProvider.getTools('ars_test');
    expect(tools.map((t) => t.id)).toEqual(['wiki.commit_document', 'wiki.check_mermaid']);
  });

  it('caches tools per session id', () => {
    mockTryGetSession.mockReturnValue({
      sessionMetadata: { snapshotId: 'snap-1', phase: 'document-writer' },
    });

    const first = wikiSessionToolProvider.getTools('ars_test');
    const second = wikiSessionToolProvider.getTools('ars_test');
    expect(first).toBe(second);
  });

  it('returns empty for non-wiki-write phases', () => {
    mockTryGetSession.mockReturnValue({
      sessionMetadata: { snapshotId: 'snap-1', phase: 'planner' },
    });

    expect(wikiSessionToolProvider.getTools('ars_test')).toEqual([]);
  });

  it('passes targetDocumentId from session metadata in commit hook', async () => {
    const { persistWikiDocumentCommit, toCommitInput } = await import('../wiki-commit-persistence.js');
    const { publishDocumentCommittedEvent } = await import('../wiki-snapshot-events.js');
    const { wikiStore } = await import('../wiki-store.js');

    mockTryGetSession.mockReturnValue({
      sessionMetadata: {
        snapshotId: 'snap-1',
        phase: 'document-writer',
        documentId: 'doc-1',
      },
    });

    mockGetSession.mockReturnValue({
      projectId: 'proj-1',
      sessionMetadata: {
        snapshotId: 'snap-1',
        phase: 'document-writer',
        documentId: 'doc-1',
      },
    });

    vi.mocked(toCommitInput).mockReturnValue({
      title: 'Overview',
      docType: 'landscape',
      markdown: '# Overview',
      references: [],
    });
    vi.mocked(persistWikiDocumentCommit).mockResolvedValue('doc-1');
    vi.mocked(wikiStore.updateDocumentPipelineStage).mockResolvedValue(undefined);
    vi.mocked(publishDocumentCommittedEvent).mockResolvedValue(undefined);

    const hooks = wikiSessionToolProvider.getHooks('ars_test');
    await hooks[0]?.afterExecute?.({
      sessionId: 'ars_test',
      args: {},
      result: { result: { ok: true } },
    } as never);

    expect(persistWikiDocumentCommit).toHaveBeenCalledWith(expect.objectContaining({
      targetDocumentId: 'doc-1',
      snapshotId: 'snap-1',
    }));
    expect(publishDocumentCommittedEvent).toHaveBeenCalledWith('proj-1', 'doc-1');
  });
});
