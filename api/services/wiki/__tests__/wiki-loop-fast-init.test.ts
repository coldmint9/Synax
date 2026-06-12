import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CodeMapScanResult } from '../../contracts/code-map.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGenerateOutlineFast = vi.fn();
const mockUpsertDocument = vi.fn();
const mockUpdateSnapshotStatus = vi.fn();
const mockCreateSnapshot = vi.fn();
const mockSessionCreate = vi.fn();
const mockStreamRun = vi.fn();

vi.mock('../wiki-fast-planner.js', () => ({
  generateOutlineFast: (...args: unknown[]) => mockGenerateOutlineFast(...args),
}));

vi.mock('../../../lib/env.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WIKI_FAST_INIT: true,
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../analyzer/scan.js', () => ({}));

vi.mock('../wiki-scan-cache.js', () => ({
  acquireCodeMapScan: vi.fn(async () => ({ scan: makeScan(), fromCache: false, cacheKind: null })),
  fallbackGitState: vi.fn(() => ({ branch: 'main', headCommitSha: 'a'.repeat(40), workingTreeHash: 'wt', dirty: false })),
}));

vi.mock('../wiki-snapshot-service.js', () => ({
  readGitState: vi.fn(() => ({ branch: 'main', headCommitSha: 'a'.repeat(40), workingTreeHash: 'wt', dirty: false })),
}));

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    createSnapshot: (...args: unknown[]) => mockCreateSnapshot(...args),
    updateSnapshotStatus: (...args: unknown[]) => mockUpdateSnapshotStatus(...args),
    upsertDocument: (...args: unknown[]) => mockUpsertDocument(...args),
  },
}));

vi.mock('../wiki-snapshot-events.js', () => ({
  publishLatestWikiSnapshot: vi.fn(async () => undefined),
  publishDocumentCommittedEvent: vi.fn(async () => undefined),
  WikiSnapshotEventReason: {
    GenerationStarted: 'generation_started',
    GenerationFailed: 'generation_failed',
    GenerationCompleted: 'generation_completed',
    OutlineReady: 'outline_ready',
    WritingStarted: 'writing_started',
    ContinueStarted: 'continue_started',
    ContinueCompleted: 'continue_completed',
    ContinueFailed: 'continue_failed',
  },
}));

vi.mock('../../notifications/notify.js', () => ({ notify: vi.fn() }));

vi.mock('../wiki-loop-profile.js', () => ({
  ensureWikiProfileRegistered: vi.fn(),
}));

vi.mock('../../agent-runtime/loop-runtime.js', () => ({
  agentLoopRuntime: { streamRun: (...args: unknown[]) => mockStreamRun(...args) },
}));

vi.mock('../../agent-runtime/event-service.js', () => ({
  agentEventService: { append: vi.fn() },
}));

vi.mock('../../agent-runtime/session-runtime.js', () => ({
  agentSessionRuntime: { create: (...args: unknown[]) => mockSessionCreate(...args) },
}));

vi.mock('../../agent-runtime/session-store.js', () => ({
  agentRuntimeStore: { updateSession: vi.fn(), tryGetSession: vi.fn(() => ({ status: 'completed' })) },
}));

vi.mock('../../agent-runtime/tool-registry.js', () => ({
  toolRegistry: { register: vi.fn(), unregister: vi.fn(), registerHook: vi.fn(), unregisterHook: vi.fn() },
}));

vi.mock('../../agent-runtime/tools/workspace.js', () => ({
  resolveWorkspaceRoot: (p?: string) => p ?? '/tmp/work',
  setSessionWorkspaceRoot: vi.fn(),
  clearSessionWorkspaceRoot: vi.fn(),
}));

import { wikiLoopService } from '../wiki-loop-service.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeScan(): CodeMapScanResult {
  return {
    projectId: 'proj-1',
    scanId: 'scan-1',
    workDir: '/tmp/work',
    codeIndex: {
      indexId: 'idx-1',
      files: [{ id: 'f1', path: 'src/auth/login.ts', language: 'typescript', sha: 'a', size: 100 }],
      symbols: [],
      chunks: [],
      imports: [],
      callEdges: [],
      stats: { fileCount: 1, symbolCount: 0, chunkCount: 0, importCount: 0, callEdgeCount: 0 },
      updatedAt: 0,
    },
    semanticGraph: { nodes: [], edges: [] },
    moduleMap: { topDirs: [], languages: [], entryFiles: [], coreSymbols: [], dependencies: [] },
    communities: [],
    warnings: [],
    generatedAt: 0,
    durationMs: 0,
  } as unknown as CodeMapScanResult;
}

const outline = [
  { id: 'landscape', docType: 'landscape', title: 'Landscape', targetFiles: [], keyQuestions: ['q one long enough', 'q two long enough'] },
  { id: 'mod-auth', docType: 'module', title: 'Auth', targetFiles: ['src/auth/login.ts'], keyQuestions: ['q one long enough', 'q two long enough'] },
];

describe('wikiLoopService.generate fast init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSnapshot.mockResolvedValue({ id: 'snap-1', projectId: 'proj-1' });
    mockUpdateSnapshotStatus.mockResolvedValue(undefined);
    let docSeq = 0;
    mockUpsertDocument.mockImplementation(async () => ({ id: `doc-${++docSeq}` }));
  });

  it('uses the fast outline and skips the planner agent entirely', async () => {
    mockGenerateOutlineFast.mockResolvedValueOnce({ outline, repaired: false });

    const result = await wikiLoopService.generate({ projectId: 'proj-1', workDir: '/tmp/work' });

    expect(result.status).toBe('outline_ready');
    expect(result.docCount).toBe(2);
    expect(mockUpsertDocument).toHaveBeenCalledTimes(2);
    expect(mockUpdateSnapshotStatus).toHaveBeenCalledWith('snap-1', 'outline_ready', ['doc-1', 'doc-2']);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockStreamRun).not.toHaveBeenCalled();
  });

  it('falls back to the planner agent when the fast path returns null', async () => {
    mockGenerateOutlineFast.mockResolvedValueOnce(null);
    mockSessionCreate.mockReturnValue({ id: 'sess-1' });
    mockStreamRun.mockImplementation(async function* () {
      yield { type: 'done' };
    });

    const result = await wikiLoopService.generate({ projectId: 'proj-1', workDir: '/tmp/work' });

    // Planner agent path engaged (it produces no outline here, so the run fails,
    // but the fallback itself is what we assert).
    expect(mockSessionCreate).toHaveBeenCalled();
    expect(mockStreamRun).toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });
});
