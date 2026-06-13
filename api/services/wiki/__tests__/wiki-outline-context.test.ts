import { describe, it, expect } from 'vitest';
import type { CodeMapScanResult, CodeMapCommunity } from '../../contracts/code-map.js';
import type { PackageBaseline } from '../tools/package-baseline.js';
import { buildCommunityBreakdownSegment } from '../wiki-outline-context.js';

function community(id: string, fileIds: string[], hub?: { fileId: string; name: string }): CodeMapCommunity {
  return {
    id,
    label: `${id}-label`,
    summary: '',
    fileIds,
    symbolIds: [],
    hubSymbols: hub
      ? [{ id: `${id}-hub`, fileId: hub.fileId, path: '', kind: 'function', name: hub.name, qualifiedName: hub.name, degree: 1, centrality: 0.5 }]
      : [],
    score: fileIds.length,
    fileCount: fileIds.length,
    symbolCount: fileIds.length,
  };
}

function makeScan(communities: CodeMapCommunity[], files: { id: string; path: string }[]): CodeMapScanResult {
  return {
    codeIndex: {
      files: files.map(f => ({ id: f.id, path: f.path, language: 'typescript', size: 10, sha: f.id })),
      symbols: files.map(f => ({ id: `${f.id}_s`, fileId: f.id, kind: 'function', name: 'fn', qualifiedName: 'fn', range: { startLine: 1, endLine: 2 } })),
    },
    communities,
  } as unknown as CodeMapScanResult;
}

function splitPackage(fileIds: string[]): PackageBaseline {
  return {
    id: 'pkg-app',
    label: 'src/components',
    dirPath: 'packages/app/src/components',
    fileIds,
    fileCount: 25,
    symbolCount: 200,
    hubSymbols: [],
  };
}

describe('buildCommunityBreakdownSegment', () => {
  const files = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, path: `packages/app/src/components/c${i}.tsx` }));

  it('proposes one sub-module per cohesive community in a SPLIT package', () => {
    const communities = [
      community('comm-a', ['f0', 'f1', 'f2', 'f3'], { fileId: 'f0', name: 'PromptInput' }),
      community('comm-b', ['f4', 'f5', 'f6'], { fileId: 'f4', name: 'DialogSelect' }),
    ];
    const seg = buildCommunityBreakdownSegment(makeScan(communities, files), [splitPackage(files.map(f => f.id))]);

    expect(seg).toContain('Suggested Sub-Module Breakdown');
    expect(seg).toContain('src/components (packages/app/src/components) — 2 suggested sub-modules');
    expect(seg).toContain('hub: PromptInput');
    expect(seg).toContain('packages/app/src/components/c0.tsx');
    expect(seg).toContain('parent module document plus one child module document');
  });

  it('omits packages where clustering found fewer than 2 cohesive groups', () => {
    const communities = [community('comm-a', ['f0', 'f1', 'f2', 'f3'])];
    const seg = buildCommunityBreakdownSegment(makeScan(communities, files), [splitPackage(files.map(f => f.id))]);
    expect(seg).toBe('');
  });

  it('ignores communities whose overlap with the package is too small', () => {
    const communities = [
      community('comm-a', ['f0', 'f1', 'f2', 'f3']),
      community('comm-tiny', ['f4', 'external-1']), // only 1 file in package → below MIN_SUBDOC_OVERLAP
    ];
    const seg = buildCommunityBreakdownSegment(makeScan(communities, files), [splitPackage(files.map(f => f.id))]);
    // Only one qualifying community remains → no breakdown emitted.
    expect(seg).toBe('');
  });
});
