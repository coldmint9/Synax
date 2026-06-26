import { describe, expect, it } from 'vitest';
import type { CodeMapScanResult } from '../../../contracts/code-map.js';
import { buildAgentCodeMapContext, isAgentRelevantPath } from '../agent-code-map-context.js';

function makeScan(): CodeMapScanResult {
  return {
    scanId: 'scan-1',
    codeIndex: {
      files: [
        { id: 'f1', path: 'api/services/agent-runtime/loop-prompt.ts', language: 'typescript' },
        { id: 'f2', path: 'api/services/agent-runtime/__tests__/loop-prompt.test.ts', language: 'typescript' },
      ],
      symbols: [
        {
          id: 's1',
          fileId: 'f1',
          kind: 'function',
          name: 'buildLoopSystemPrompt',
          qualifiedName: 'buildLoopSystemPrompt',
          signature: 'function buildLoopSystemPrompt()',
        },
        {
          id: 's2',
          fileId: 'f2',
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
      dependencies: [{ source: 'api/services/agent-runtime', target: 'api/lib', kind: 'import', weight: 3 }],
      entryFiles: [
        { path: 'api/index.ts', language: 'typescript', symbolCount: 2 },
        { path: 'api/services/agent-runtime/__tests__/x.test.ts', language: 'typescript', symbolCount: 1 },
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
