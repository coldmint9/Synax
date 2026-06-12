import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import type { WikiGitState } from '../wiki-snapshot-service.js';

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockRunCodeMapScan = vi.fn();

vi.mock('../../../db/index.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mockSelect,
          orderBy: () => ({ limit: mockSelect }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: mockInsert }),
    }),
  }),
}));

vi.mock('../../analyzer/scan.js', () => ({
  runCodeMapScan: (...args: unknown[]) => mockRunCodeMapScan(...args),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  fallbackGitState,
  loadCachedScanWithFallback,
  acquireCodeMapScan,
  NO_GIT_WORKING_TREE_HASH,
} from '../wiki-scan-cache.js';

function makeScan(): CodeMapScanResult {
  return {
    projectId: 'proj-1',
    scanId: 'scan-1',
    workDir: '/tmp',
    codeIndex: { files: [{ id: 'f1', path: 'a.ts' }], symbols: [], chunks: [], imports: [], callEdges: [], stats: {}, indexId: 'i', updatedAt: 0 },
    semanticGraph: { nodes: [], edges: [] },
    warnings: [],
    generatedAt: 0,
    durationMs: 0,
  } as unknown as CodeMapScanResult;
}

const gitState: WikiGitState = {
  branch: 'main',
  headCommitSha: 'a'.repeat(40),
  workingTreeHash: 'deadbeef00000000',
  dirty: false,
};

describe('fallbackGitState', () => {
  it('uses a stable workingTreeHash (not random)', () => {
    expect(fallbackGitState().workingTreeHash).toBe(NO_GIT_WORKING_TREE_HASH);
    expect(fallbackGitState().workingTreeHash).toBe(fallbackGitState().workingTreeHash);
  });
});

describe('loadCachedScanWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue(undefined);
  });

  it('returns exact cache hit without scanning', async () => {
    mockSelect.mockResolvedValueOnce([{ resultJson: JSON.stringify(makeScan()) }]);

    const hit = await loadCachedScanWithFallback('proj-1', gitState);
    expect(hit?.kind).toBe('git-exact');
    expect(mockRunCodeMapScan).not.toHaveBeenCalled();
  });

  it('falls back to commit-level cache when tree is clean', async () => {
    mockSelect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ resultJson: JSON.stringify(makeScan()) }]);

    const hit = await loadCachedScanWithFallback('proj-1', gitState);
    expect(hit?.kind).toBe('git-commit');
    expect(mockRunCodeMapScan).not.toHaveBeenCalled();
  });

  it('returns null on miss', async () => {
    mockSelect.mockResolvedValue([]);

    const hit = await loadCachedScanWithFallback('proj-1', gitState);
    expect(hit).toBeNull();
  });
});

describe('acquireCodeMapScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue(undefined);
  });

  it('skips runCodeMapScan on cache hit', async () => {
    mockSelect.mockResolvedValueOnce([{ resultJson: JSON.stringify(makeScan()) }]);

    const result = await acquireCodeMapScan({ projectId: 'proj-1', workDir: '/tmp', gitState });
    expect(result.fromCache).toBe(true);
    expect(mockRunCodeMapScan).not.toHaveBeenCalled();
  });

  it('runs scan and persists on cache miss', async () => {
    mockSelect.mockResolvedValue([]);
    mockRunCodeMapScan.mockResolvedValueOnce(makeScan());

    const result = await acquireCodeMapScan({ projectId: 'proj-1', workDir: '/tmp', gitState });
    expect(result.fromCache).toBe(false);
    expect(mockRunCodeMapScan).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalled();
  });
});
