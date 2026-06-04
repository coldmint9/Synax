import { describe, it, expect } from 'vitest';
import type { ToolCallRecord } from '../contracts.js';
import type { FallbackDisclosureConfig } from '../contracts.js';
import {
  createFallbackState,
  rebuildFallbackState,
  advanceFallbackState,
  filterFallbackTools,
  isBashError,
} from '../tool-disclosure.js';

const config: FallbackDisclosureConfig = {
  fallbackToolIds: ['file.read', 'file.list', 'file.glob', 'grep.search', 'diff.read'],
  trackedToolId: 'bash',
  consecutiveErrorThreshold: 4,
};

function makeRecord(toolId: string, exitCode: number | null, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: `tc-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    runId: 'run-1',
    stepId: 'step-1',
    modelToolCallId: null,
    toolId,
    category: 'read',
    mutability: 'read',
    argsHash: '',
    inputSummary: '',
    inputRef: null,
    outputSummary: `bash (exit ${exitCode})`,
    outputRef: { exitCode },
    status: 'completed',
    permissionDecisionId: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

describe('isBashError', () => {
  it('exitCode 0 is not an error', () => {
    expect(isBashError(makeRecord('bash', 0))).toBe(false);
  });

  it('exitCode 1 is an error', () => {
    expect(isBashError(makeRecord('bash', 1))).toBe(true);
  });

  it('exitCode null (whitelist rejection) is an error', () => {
    expect(isBashError(makeRecord('bash', null))).toBe(true);
  });

  it('exitCode 127 (command not found) is an error', () => {
    expect(isBashError(makeRecord('bash', 127))).toBe(true);
  });
});

describe('createFallbackState', () => {
  it('starts undisclosed with zero errors', () => {
    const state = createFallbackState();
    expect(state.consecutiveErrors).toBe(0);
    expect(state.disclosed).toBe(false);
  });
});

describe('advanceFallbackState', () => {
  it('increments on bash error', () => {
    let state = createFallbackState();
    const { state: next } = advanceFallbackState(state, makeRecord('bash', 1), config);
    expect(next.consecutiveErrors).toBe(1);
    expect(next.disclosed).toBe(false);
  });

  it('resets on bash success', () => {
    const state = { consecutiveErrors: 3, disclosed: false };
    const { state: next } = advanceFallbackState(state, makeRecord('bash', 0), config);
    expect(next.consecutiveErrors).toBe(0);
    expect(next.disclosed).toBe(false);
  });

  it('discloses at threshold', () => {
    let state = { consecutiveErrors: 3, disclosed: false };
    const { state: next, justDisclosed } = advanceFallbackState(state, makeRecord('bash', 1), config);
    expect(next.consecutiveErrors).toBe(4);
    expect(next.disclosed).toBe(true);
    expect(justDisclosed).toBe(true);
  });

  it('does not trigger justDisclosed after already disclosed', () => {
    const state = { consecutiveErrors: 5, disclosed: true };
    const { state: next, justDisclosed } = advanceFallbackState(state, makeRecord('bash', 1), config);
    expect(next.disclosed).toBe(true);
    expect(justDisclosed).toBe(false);
  });

  it('ignores non-tracked tools', () => {
    const state = { consecutiveErrors: 3, disclosed: false };
    const { state: next } = advanceFallbackState(state, makeRecord('file.read', 1), config);
    expect(next.consecutiveErrors).toBe(3);
  });
});

describe('rebuildFallbackState', () => {
  it('rebuilds from empty history', () => {
    const state = rebuildFallbackState([], config);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.disclosed).toBe(false);
  });

  it('counts consecutive errors correctly', () => {
    const calls = [
      makeRecord('bash', 0),
      makeRecord('bash', 1),
      makeRecord('bash', 1),
      makeRecord('bash', 1),
    ];
    const state = rebuildFallbackState(calls, config);
    expect(state.consecutiveErrors).toBe(3);
    expect(state.disclosed).toBe(false);
  });

  it('discloses when threshold is met', () => {
    const calls = [
      makeRecord('bash', 1),
      makeRecord('bash', 1),
      makeRecord('bash', 1),
      makeRecord('bash', 1),
    ];
    const state = rebuildFallbackState(calls, config);
    expect(state.consecutiveErrors).toBe(4);
    expect(state.disclosed).toBe(true);
  });

  it('resets streak on success in the middle', () => {
    const calls = [
      makeRecord('bash', 1),
      makeRecord('bash', 1),
      makeRecord('bash', 0),
      makeRecord('bash', 1),
      makeRecord('bash', 1),
    ];
    const state = rebuildFallbackState(calls, config);
    expect(state.consecutiveErrors).toBe(2);
    expect(state.disclosed).toBe(false);
  });
});

describe('filterFallbackTools', () => {
  const tools = [
    { id: 'bash' },
    { id: 'file.read' },
    { id: 'file.glob' },
    { id: 'grep.search' },
    { id: 'wiki.commit_document' },
  ];

  it('hides fallback tools when not disclosed', () => {
    const visible = filterFallbackTools(tools, { consecutiveErrors: 0, disclosed: false }, config);
    expect(visible.map(t => t.id)).toEqual(['bash', 'wiki.commit_document']);
  });

  it('shows all tools when disclosed', () => {
    const visible = filterFallbackTools(tools, { consecutiveErrors: 4, disclosed: true }, config);
    expect(visible.map(t => t.id)).toEqual(['bash', 'file.read', 'file.glob', 'grep.search', 'wiki.commit_document']);
  });
});
