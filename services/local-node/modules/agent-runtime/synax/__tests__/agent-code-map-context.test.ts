import { describe, expect, it } from 'vitest';
import type { CodeMapScanResult } from '../../../contracts/code-map.js';
import { buildAgentCodeMapContext, isAgentRelevantPath } from '../agent-code-map-context.js';

function makeScan(): CodeMapScanResult {
  return {
    projectId: 'fixture-project', scanId: 'scan-1', generatedAt: 1, durationMs: 1, workDir: '/tmp/project',
    semanticGraph: { nodes: [], edges: [] }, warnings: [],
    codeIndex: {
      indexId: 'index-1', chunks: [], updatedAt: 1, stats: { fileCount: 2, symbolCount: 2, chunkCount: 0, importCount: 0, callEdgeCount: 0 },
      files: [
        { id: 'f1', path: 'api/services/agent-runtime/loop-prompt.ts', language: 'typescript', size: 10, sha: 'fixture' },
        { id: 'f2', path: 'api/services/agent-runtime/__tests__/loop-prompt.test.ts', language: 'typescript', size: 10, sha: 'fixture' },
      ],
      symbols: [
        {
          id: 's1',
          fileId: 'f1', range: { startLine: 1, endLine: 2 },
          kind: 'function',
          name: 'buildLoopSystemPrompt',
          qualifiedName: 'buildLoopSystemPrompt',
          signature: 'function buildLoopSystemPrompt()',
        },
        {
          id: 's2',
          fileId: 'f2', range: { startLine: 1, endLine: 2 },
          kind: 'function',
          name: 'makeRecord',
          qualifiedName: 'makeRecord',
          signature: 'function makeRecord()',
        },
      ],
      imports: [],
      callEdges: [],
    },
    moduleMap: {
      topDirs: [], languages: [], coreSymbols: [],
      dependencies: [{ source: 'api/services/agent-runtime', target: 'api/lib', kind: 'import', weight: 3 }],
      entryFiles: [
        { fileId: 'entry', importCount: 0, score: 1, path: 'api/index.ts', language: 'typescript', symbolCount: 2 },
        { fileId: 'test-entry', importCount: 0, score: 1, path: 'api/services/agent-runtime/__tests__/x.test.ts', language: 'typescript', symbolCount: 1 },
      ],
    },
    communities: [],
  };
}

describe('isAgentRelevantPath', () => {
  it('excludes test and fixture paths', () => {
    expect(isAgentRelevantPath('api/foo.ts')).toBe(true);
    expect(isAgentRelevantPath('api/__tests__/foo.test.ts')).toBe(false);
    expect(isAgentRelevantPath('api/foo.spec.ts')).toBe(false);
  });
});

describe('buildAgentCodeMapContext', () => {
  it('omits test hub symbols and respects size budget', () => {
    const context = buildAgentCodeMapContext(makeScan(), '/tmp/project', { maxChars: 4000 });
    expect(context).toContain('buildLoopSystemPrompt');
    expect(context).not.toContain('__tests__');
    expect(context).not.toContain('makeRecord');
    expect(context.length).toBeLessThanOrEqual(4000);
  });

  it('prioritizes packages matching focus prompt keywords', () => {
    const context = buildAgentCodeMapContext(makeScan(), '/tmp/project', {
      focusPrompt: 'agent-runtime loop prompt',
      maxChars: 4000,
    });
    expect(context.indexOf('agent-runtime')).toBeGreaterThanOrEqual(0);
  });
});
