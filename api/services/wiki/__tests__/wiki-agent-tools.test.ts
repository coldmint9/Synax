import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import { resetAgentRuntimeFixtures } from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';
import { createWikiAgentTools } from '../tools/agent-tools.js';

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getLatestSnapshot: vi.fn(),
    getSnapshot: vi.fn(),
    getDocumentsBySnapshot: vi.fn(),
    getDocument: vi.fn(),
    hasActiveGeneration: vi.fn(),
  },
}));

vi.mock('../wiki-fts.js', () => ({
  searchWikiDocuments: vi.fn(),
}));

import { wikiStore } from '../wiki-store.js';
import { searchWikiDocuments } from '../wiki-fts.js';

const mockedStore = vi.mocked(wikiStore);
const mockedSearch = vi.mocked(searchWikiDocuments);

describe('createWikiAgentTools', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    vi.clearAllMocks();
  });

  it('registers eight read-only wiki agent tools', () => {
    const tools = createWikiAgentTools();
    expect(tools.map((t) => t.id)).toEqual([
      'wiki.get_snapshot',
      'wiki.get_tree',
      'wiki.list_documents',
      'wiki.read_document',
      'wiki.read_section',
      'wiki.get_references',
      'wiki.search_content',
      'wiki.search_batch',
    ]);
  });

  it('wiki.get_snapshot resolves project from session', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'proj-1',
      profileId: 'explorer',
      prompt: 'explore wiki',
    });
    mockedStore.getLatestSnapshot.mockResolvedValue({
      id: 'snap-1',
      projectId: 'proj-1',
      branch: 'main',
      headCommitSha: 'abc',
      workingTreeHash: 'def',
      repoIndexId: null,
      revision: 3,
      status: 'ready',
      documentIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'agent',
    });
    mockedStore.getDocumentsBySnapshot.mockResolvedValue([
      {
        id: 'd1',
        snapshotId: 'snap-1',
        projectId: 'proj-1',
        title: 'Overview',
        docType: 'landscape',
        parentId: null,
        contentMd: '# Hello',
        references: [],
        pipelineStage: 'done',
        sortOrder: 0,
        manualState: 'none',
        staleState: 'fresh',
        isSection: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockedStore.hasActiveGeneration.mockResolvedValue({ active: false });

    const tool = createWikiAgentTools().find((t) => t.id === 'wiki.get_snapshot')!;
    const result = await tool.execute({
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolCallId: 'tc-1',
      toolId: tool.id,
      category: 'read',
      mutability: 'read',
      args: {},
    });

    expect(mockedStore.getLatestSnapshot).toHaveBeenCalledWith('proj-1');
    expect(result.result).toMatchObject({
      ok: true,
      snapshot: { id: 'snap-1', revision: 3, documentsWithContent: 1 },
      generationActive: false,
    });
  });

  it('wiki.search_content runs FTS and enriches titles', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'proj-1',
      profileId: 'explorer',
      prompt: 'search wiki',
    });
    mockedStore.getLatestSnapshot.mockResolvedValue({
      id: 'snap-1',
      projectId: 'proj-1',
      branch: 'main',
      headCommitSha: 'abc',
      workingTreeHash: 'def',
      repoIndexId: null,
      revision: 1,
      status: 'ready',
      documentIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'agent',
    });
    mockedSearch.mockReturnValue([
      { documentId: 'd1', snippet: '…认证流程…', rank: -1.2 },
    ]);
    mockedStore.getDocumentsBySnapshot.mockResolvedValue([
      {
        id: 'd1',
        snapshotId: 'snap-1',
        projectId: 'proj-1',
        title: 'Auth Flow',
        docType: 'flow',
        parentId: null,
        contentMd: '认证流程说明',
        references: [],
        pipelineStage: 'done',
        sortOrder: 0,
        manualState: 'none',
        staleState: 'fresh',
        isSection: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const tool = createWikiAgentTools().find((t) => t.id === 'wiki.search_content')!;
    const result = await tool.execute({
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolCallId: 'tc-2',
      toolId: tool.id,
      category: 'read',
      mutability: 'read',
      args: { query: '认证' },
    });

    expect(mockedSearch).toHaveBeenCalledWith({
      projectId: 'proj-1',
      query: '认证',
      limit: 20,
      documentId: undefined,
    });
    expect(result.result).toMatchObject({
      ok: true,
      total: 1,
      matches: [{ documentId: 'd1', documentTitle: 'Auth Flow', rank: -1.2 }],
    });
  });

  it('wiki.search_batch runs parallel FTS queries', async () => {
    const session = agentSessionRuntime.create({
      projectId: 'proj-1',
      profileId: 'explorer',
      prompt: 'batch search',
    });
    mockedStore.getLatestSnapshot.mockResolvedValue({
      id: 'snap-1',
      projectId: 'proj-1',
      branch: 'main',
      headCommitSha: 'abc',
      workingTreeHash: 'def',
      repoIndexId: null,
      revision: 1,
      status: 'ready',
      documentIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'agent',
    });
    mockedStore.getDocumentsBySnapshot.mockResolvedValue([
      {
        id: 'd1',
        snapshotId: 'snap-1',
        projectId: 'proj-1',
        title: 'Auth Flow',
        docType: 'flow',
        parentId: null,
        contentMd: 'content',
        references: [],
        pipelineStage: 'done',
        sortOrder: 0,
        manualState: 'none',
        staleState: 'fresh',
        isSection: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockedSearch.mockImplementation(({ query }) => [
      { documentId: 'd1', snippet: `hit for ${query}`, rank: -1 },
    ]);

    const tool = createWikiAgentTools().find((t) => t.id === 'wiki.search_batch')!;
    const result = await tool.execute({
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolCallId: 'tc-3',
      toolId: tool.id,
      category: 'read',
      mutability: 'read',
      args: { queries: ['auth', 'token'] },
    });

    expect(mockedSearch).toHaveBeenCalledTimes(2);
    expect(result.result).toMatchObject({
      ok: true,
      queryCount: 2,
      totalMatches: 2,
      results: [
        { query: 'auth', total: 1 },
        { query: 'token', total: 1 },
      ],
    });
  });

  it('wiki.read_section extracts a heading slice', async () => {
    mockedStore.getDocument.mockResolvedValue({
      id: 'd1',
      snapshotId: 'snap-1',
      projectId: 'proj-1',
      title: 'Auth',
      docType: 'flow',
      parentId: null,
      contentMd: '# Auth\n\n## Login\n\nLogin details.\n\n## Logout\n\nLogout details.',
      references: [],
      pipelineStage: 'done',
      sortOrder: 0,
      manualState: 'none',
      staleState: 'fresh',
      isSection: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const session = agentSessionRuntime.create({
      projectId: 'proj-1',
      profileId: 'explorer',
      prompt: 'read section',
    });
    const tool = createWikiAgentTools().find((t) => t.id === 'wiki.read_section')!;
    const result = await tool.execute({
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolCallId: 'tc-4',
      toolId: tool.id,
      category: 'read',
      mutability: 'read',
      args: { documentId: 'd1', heading: 'Login' },
    });

    expect(result.result).toMatchObject({
      ok: true,
      heading: 'Login',
      contentMd: expect.stringContaining('Login details'),
    });
    expect((result.result as { contentMd: string }).contentMd).not.toContain('Logout');
  });

  it('wiki.get_references groups refs by file', async () => {
    mockedStore.getDocument.mockResolvedValue({
      id: 'd1',
      snapshotId: 'snap-1',
      projectId: 'proj-1',
      title: 'Auth',
      docType: 'flow',
      parentId: null,
      contentMd: '# Auth',
      references: [
        { filePath: 'src/auth.ts', startLine: 1, endLine: 20, symbol: 'login' },
        { filePath: 'src/auth.ts', startLine: 40, endLine: 55, symbol: 'logout' },
        { filePath: 'src/token.ts', startLine: 10, endLine: 30 },
      ],
      pipelineStage: 'done',
      sortOrder: 0,
      manualState: 'none',
      staleState: 'fresh',
      isSection: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const session = agentSessionRuntime.create({
      projectId: 'proj-1',
      profileId: 'explorer',
      prompt: 'refs',
    });
    const tool = createWikiAgentTools().find((t) => t.id === 'wiki.get_references')!;
    const result = await tool.execute({
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolCallId: 'tc-5',
      toolId: tool.id,
      category: 'read',
      mutability: 'read',
      args: { documentId: 'd1' },
    });

    expect(result.result).toMatchObject({
      ok: true,
      totalReferences: 3,
      uniqueFiles: 2,
      fileGroups: [
        { filePath: 'src/auth.ts', refs: expect.any(Array) },
        { filePath: 'src/token.ts', refs: expect.any(Array) },
      ],
    });
  });
});
