import { describe, expect, it, vi } from 'vitest';
import { advanceMergeWorker } from './worker-flow.js';
import type { ConversationGitSnapshot } from './contracts.js';

function fixture(status = 'draft') {
  const state = { task: { id: 'task' }, execution: { status: 'running' }, mr: {
    status, currentStep: 0, candidateOid: 'candidate', candidateTree: 'tree', steps: [{ status: 'pending' }],
    checks: [{ id: 'test' }], checkResults: [],
  } } as unknown as ConversationGitSnapshot;
  const flow = {
    snapshot: async () => structuredClone(state),
    action: vi.fn(async (action: string) => {
      if (action === 'prepare') state.mr.status = 'conflicted';
      if (action === 'continue' || action === 'resume') state.mr.status = 'ready';
      if (action === 'checks') state.mr.checkResults = [{ id: 'test', tree: 'tree', status: 'passed', output: '', finishedAt: '' }];
      if (action === 'finalize') state.mr.status = 'merged';
    }),
    packet: vi.fn(async () => ({ totalFiles: 1, files: [], mrVersion: 1, target: 'integration', source: 'feature', nextOffset: null })),
    diagnostics: vi.fn(async () => ({ candidateOid: 'candidate', candidateTree: 'tree', files: ['helper.ts'], attempts: 0, remainingAttempts: 3, checks: [] })),
    waiting: vi.fn(async () => {}),
  };
  return { state, flow };
}

describe('automatic merge progression', () => {
  it('prepares once and returns only the conflict decision', async () => {
    const { flow } = fixture();
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'conflicts', packet: { totalFiles: 1 } });
    expect(flow.action.mock.calls.map(([action]) => action)).toEqual(['prepare']);
  });
  it('continues staged resolutions, runs checks and finalizes without model orchestration', async () => {
    const { flow } = fixture('conflicted'); flow.packet.mockResolvedValue({ totalFiles: 0, files: [], mrVersion: 1, target: 'integration', source: 'feature', nextOffset: null });
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'done', status: 'merged' });
    expect(flow.action.mock.calls.map(([action]) => action)).toEqual(['continue', 'checks', 'finalize']);
  });
  it('requires checks for the current candidate tree', async () => {
    const { state, flow } = fixture('ready');
    state.mr.checkResults = [{ id: 'test', status: 'passed', tree: 'old-tree', output: '', finishedAt: '' }];
    await advanceMergeWorker(flow);
    expect(flow.action.mock.calls.map(([action]) => action)).toEqual(['checks', 'finalize']);
  });
  it('returns diagnostic repair rather than rerunning an unchanged failed check', async () => {
    const { flow } = fixture('check_failed');
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'repair', diagnostics: { files: ['helper.ts'] } });
    expect(flow.action).not.toHaveBeenCalled();
  });
  it('stops at missing checks, exhausted repair rounds and stopped execution', async () => {
    const { state, flow } = fixture('ready'); state.mr.checks = [];
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'waiting' });
    expect(flow.action).not.toHaveBeenCalled(); expect(flow.waiting).toHaveBeenCalledOnce();
    state.mr.status = 'check_failed';
    flow.diagnostics.mockResolvedValue({ candidateOid: 'candidate', candidateTree: 'tree', files: ['helper.ts'], attempts: 3, remainingAttempts: 0, checks: [] });
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'waiting', reason: expect.stringContaining('three') });
    state.execution!.status = 'paused';
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'waiting' });
    expect(flow.action).not.toHaveBeenCalled();
  });
  it('detects a reentrant action that only changes version counters', async () => {
    const { state, flow } = fixture('draft');
    flow.action.mockImplementation(async () => { state.mr.version++; });
    expect(await advanceMergeWorker(flow)).toMatchObject({ decision: 'waiting', reason: expect.stringContaining('did not advance') });
    expect(flow.action).toHaveBeenCalledOnce();
  });
});
