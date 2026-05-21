// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-coordinate-service.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({ select: mockSelect }) }));
vi.mock('../../../db/schema.js', () => ({
  wikiSourceBindings: { id: 'id', projectId: 'project_id', wikiBlockId: 'wiki_block_id' },
  wikiSourceBlockIndex: { projectId: 'project_id', repoIndexId: 'repo_index_id', sourceId: 'source_id' },
}));

import { buildLocator, wikiCoordinateService } from '../wiki-coordinate-service.js';
import type { CodeIndex, SourceLink } from '../../contracts/forest.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCodeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    files: [
      { id: 'file-1', path: 'src/foo.ts', language: 'typescript', sha: 'sha-file-1', size: 100, symbolIds: [], chunkIds: [] },
    ],
    symbols: [
      {
        id: 'sym-1', fileId: 'file-1', kind: 'function', name: 'doThing',
        qualifiedName: 'src/foo.ts::doThing', signature: '() => void',
        range: { startLine: 10, endLine: 20 },
        dependsOn: [], dependedBy: [],
      },
    ],
    chunks: [
      { id: 'chunk-1', fileId: 'file-1', hash: 'chunk-hash-1', range: { startLine: 5, endLine: 15 } },
    ],
    ...overrides,
  } as unknown as CodeIndex;
}

function makeSourceLink(kind: string, id: string): SourceLink {
  const anchor =
    kind === 'file' ? { kind: 'file' as const, fileId: id } :
    kind === 'symbol' ? { kind: 'symbol' as const, symbolId: id } :
    kind === 'chunk' ? { kind: 'chunk' as const, chunkId: id } :
    { kind: 'concept' as const, semanticNodeId: id };

  return {
    id: `link-${id}`,
    nodeId: 'block-1',
    anchor,
    confidence: 0.9,
    createdBy: 'analyzer',
  } as unknown as SourceLink;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildLocator', () => {
  const codeIndex = makeCodeIndex();

  it('resolves file anchor to filePath + sha', () => {
    const link = makeSourceLink('file', 'file-1');
    const locator = buildLocator(link, codeIndex);
    expect(locator).not.toBeNull();
    expect(locator!.filePath).toBe('src/foo.ts');
    expect(locator!.hash).toBe('sha-file-1');
  });

  it('resolves symbol anchor to filePath + range + qualifiedName', () => {
    const link = makeSourceLink('symbol', 'sym-1');
    const locator = buildLocator(link, codeIndex);
    expect(locator).not.toBeNull();
    expect(locator!.filePath).toBe('src/foo.ts');
    expect(locator!.startLine).toBe(10);
    expect(locator!.endLine).toBe(20);
    expect(locator!.qualifiedName).toBe('src/foo.ts::doThing');
  });

  it('resolves chunk anchor to filePath + range', () => {
    const link = makeSourceLink('chunk', 'chunk-1');
    const locator = buildLocator(link, codeIndex);
    expect(locator).not.toBeNull();
    expect(locator!.filePath).toBe('src/foo.ts');
    expect(locator!.startLine).toBe(5);
    expect(locator!.hash).toBe('chunk-hash-1');
  });

  it('returns null for unknown file id', () => {
    const link = makeSourceLink('file', 'nonexistent');
    const locator = buildLocator(link, codeIndex);
    expect(locator).toBeNull();
  });

  it('returns null for unknown symbol id', () => {
    const link = makeSourceLink('symbol', 'nonexistent');
    const locator = buildLocator(link, codeIndex);
    expect(locator).toBeNull();
  });
});

describe('wikiCoordinateService.resolveBinding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns resolved=false when binding not found', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const result = await wikiCoordinateService.resolveBinding('missing');
    expect(result.resolved).toBe(false);
    expect(result.precision).toBe('file');
  });

  it('generates vscode ideUri with line number for symbol binding', async () => {
    mockLimit.mockResolvedValueOnce([{
      id: 'bind-1', projectId: 'proj-1', wikiBlockId: 'block-1',
      sourceType: 'symbol', sourceId: 'sym-1',
      lastVerifiedRepoIndexId: 'idx-1', lastVerifiedHash: 'h1',
      precision: 'symbol', confidence: 0.9, createdBy: 'analyzer',
      createdAt: '2026-01-01',
      filePath: 'src/foo.ts', startLine: 10, endLine: 20,
      qualifiedName: 'src/foo.ts::doThing',
    }]);

    const result = await wikiCoordinateService.resolveBinding('bind-1');
    expect(result.resolved).toBe(true);
    expect(result.ideUri).toBe('vscode://file/src/foo.ts:10');
    expect(result.filePath).toBe('src/foo.ts');
    expect(result.startLine).toBe(10);
    expect(result.qualifiedName).toBe('src/foo.ts::doThing');
  });

  it('generates vscode ideUri without line for file binding', async () => {
    mockLimit.mockResolvedValueOnce([{
      id: 'bind-2', projectId: 'proj-1', wikiBlockId: 'block-1',
      sourceType: 'file', sourceId: 'file-1',
      lastVerifiedRepoIndexId: 'idx-1', lastVerifiedHash: 'h1',
      precision: 'file', confidence: 0.7, createdBy: 'analyzer',
      createdAt: '2026-01-01',
      filePath: 'src/bar.ts', startLine: null, endLine: null,
      qualifiedName: null,
    }]);

    const result = await wikiCoordinateService.resolveBinding('bind-2');
    expect(result.resolved).toBe(true);
    expect(result.ideUri).toBe('vscode://file/src/bar.ts');
  });

  it('returns resolved=false and no ideUri when filePath is null', async () => {
    mockLimit.mockResolvedValueOnce([{
      id: 'bind-3', projectId: 'proj-1', wikiBlockId: 'block-1',
      sourceType: 'semantic_node', sourceId: 'node-1',
      lastVerifiedRepoIndexId: null, lastVerifiedHash: null,
      precision: 'file', confidence: 0.3, createdBy: 'agent',
      createdAt: '2026-01-01',
      filePath: null, startLine: null, endLine: null, qualifiedName: null,
    }]);

    const result = await wikiCoordinateService.resolveBinding('bind-3');
    expect(result.resolved).toBe(false);
    expect(result.ideUri).toBeUndefined();
  });
});
