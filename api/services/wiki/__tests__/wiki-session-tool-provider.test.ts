import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockTryGetSession = vi.fn();

vi.mock('../../agent-runtime/session-store.js', () => ({
  agentRuntimeStore: { tryGetSession: (...args: unknown[]) => mockTryGetSession(...args) },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../wiki-store.js', () => ({ wikiStore: {} }));
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
});
