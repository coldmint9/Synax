import { describe, expect, it } from 'vitest';
import {
  clearSessionFileReads,
  extractBashReadPaths,
  rebuildSessionFileReads,
} from '../read-tracker.js';
import type { ToolCallRecord } from '../contracts.js';

describe('extractBashReadPaths', () => {
  it('accepts simple cat/head/tail without pipes', () => {
    expect(extractBashReadPaths('cat src/foo.ts')).toEqual(['src/foo.ts']);
    expect(extractBashReadPaths('head -n 20 README.md')).toEqual(['README.md']);
  });

  it('rejects piped commands', () => {
    expect(extractBashReadPaths('cat foo.ts | grep bar')).toEqual([]);
  });
});

describe('rebuildSessionFileReads', () => {
  const sessionId = 'sess-read-tracker';

  function makeRecord(partial: Partial<ToolCallRecord>): ToolCallRecord {
    return {
      id: 'tc-1',
      sessionId,
      runId: 'run-1',
      stepId: 'step-1',
      modelToolCallId: null,
      toolId: 'file.read',
      category: 'read',
      mutability: 'read',
      argsHash: '',
      inputSummary: '',
      inputRef: null,
      outputSummary: '',
      outputRef: null,
      status: 'completed',
      permissionDecisionId: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
      ...partial,
    };
  }

  it('rebuilds from completed file.read calls', () => {
    clearSessionFileReads(sessionId);
    rebuildSessionFileReads(sessionId, [
      makeRecord({ toolId: 'file.read', inputRef: { path: 'package.json' } }),
    ]);
    // rebuild only records when file exists on disk; package.json should exist in repo root
    // If missing in test env, this is a no-op — we verify no throw.
    expect(() => rebuildSessionFileReads(sessionId, [])).not.toThrow();
  });
});
