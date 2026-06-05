import { describe, it, expect } from 'vitest';
import type { ToolCallRecord } from '../contracts.js';
import { detectDoomLoop } from '../loop-guards.js';

function makeRecord(
  toolId: string,
  stepId: string,
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    id: `tc-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    runId: 'run-1',
    stepId,
    modelToolCallId: null,
    toolId,
    category: 'read',
    mutability: 'read',
    argsHash: 'hash-a',
    inputSummary: '',
    inputRef: null,
    outputSummary: 'ok',
    outputRef: { path: 'x.ts', content: '...' },
    status: 'completed',
    permissionDecisionId: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

describe('detectDoomLoop', () => {
  it('detects 3 identical steps', () => {
    const calls = [
      makeRecord('file.read', 'step-1'),
      makeRecord('file.read', 'step-2'),
      makeRecord('file.read', 'step-3'),
    ];
    expect(detectDoomLoop(calls)).not.toBeNull();
  });

  it('does not trigger with fewer than threshold steps', () => {
    const calls = [
      makeRecord('file.read', 'step-1'),
      makeRecord('file.read', 'step-2'),
    ];
    expect(detectDoomLoop(calls)).toBeNull();
  });

  it('does not trigger when steps differ', () => {
    const calls = [
      makeRecord('file.read', 'step-1', { argsHash: 'hash-a' }),
      makeRecord('file.read', 'step-2', { argsHash: 'hash-b' }),
      makeRecord('file.read', 'step-3', { argsHash: 'hash-a' }),
    ];
    expect(detectDoomLoop(calls)).toBeNull();
  });

  it('ignores deduped (compacted + null outputRef) records for signature', () => {
    // All 3 steps only have deduped calls — should NOT trigger doom loop
    const calls = [
      makeRecord('file.read', 'step-1', { status: 'compacted', outputRef: null }),
      makeRecord('file.read', 'step-2', { status: 'compacted', outputRef: null }),
      makeRecord('file.read', 'step-3', { status: 'compacted', outputRef: null }),
    ];
    expect(detectDoomLoop(calls)).toBeNull();
  });

  it('still triggers when real (non-dedup) calls repeat', () => {
    // Steps with real completed calls that repeat
    const calls = [
      makeRecord('file.read', 'step-1', { status: 'completed', outputRef: { content: 'data' } }),
      makeRecord('file.read', 'step-2', { status: 'completed', outputRef: { content: 'data' } }),
      makeRecord('file.read', 'step-3', { status: 'completed', outputRef: { content: 'data' } }),
    ];
    expect(detectDoomLoop(calls)).not.toBeNull();
  });

  it('ignores dedup records mixed with real records in the same step', () => {
    // Each step has one real call + one dedup — signature based only on real calls
    const calls = [
      makeRecord('file.read', 'step-1', { status: 'completed', outputRef: { x: 1 }, argsHash: 'hash-a' }),
      makeRecord('grep.search', 'step-1', { status: 'compacted', outputRef: null, argsHash: 'hash-b' }),
      makeRecord('file.read', 'step-2', { status: 'completed', outputRef: { x: 1 }, argsHash: 'hash-a' }),
      makeRecord('grep.search', 'step-2', { status: 'compacted', outputRef: null, argsHash: 'hash-b' }),
      makeRecord('file.read', 'step-3', { status: 'completed', outputRef: { x: 1 }, argsHash: 'hash-a' }),
      makeRecord('grep.search', 'step-3', { status: 'compacted', outputRef: null, argsHash: 'hash-b' }),
    ];
    // Only file.read:hash-a is real in each step — same signature → triggers
    expect(detectDoomLoop(calls)).not.toBeNull();
  });

  it('respects custom threshold', () => {
    const calls = [
      makeRecord('file.read', 'step-1'),
      makeRecord('file.read', 'step-2'),
      makeRecord('file.read', 'step-3'),
      makeRecord('file.read', 'step-4'),
      makeRecord('file.read', 'step-5'),
      makeRecord('file.read', 'step-6'),
    ];
    // With threshold=6, 6 identical steps should trigger
    expect(detectDoomLoop(calls, 6)).not.toBeNull();
    // With threshold=7, not enough steps
    expect(detectDoomLoop(calls, 7)).toBeNull();
  });
});
