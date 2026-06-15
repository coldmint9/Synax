import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ snapshotId: 'snap-1', status: 'completed' as const })),
}));

vi.mock('../wiki-loop-service.js', () => ({
  wikiLoopService: { generate: mocks.generate },
}));

vi.mock('../wiki-reinitialize-runner.js', () => ({
  runReinitialize: vi.fn(async () => undefined),
}));

import { wikiJobProcess } from '../wiki-job-process.js';

describe('wikiJobProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYNAX_WIKI_JOB_IN_PROCESS = '1';
  });

  it('runs generate jobs in-process when SYNAX_WIKI_JOB_IN_PROCESS is set', async () => {
    expect(wikiJobProcess.isRunning()).toBe(false);
    expect(wikiJobProcess.start({
      kind: 'generate',
      projectId: 'proj-1',
      workDir: '/tmp/repo',
      locale: 'zh',
    })).toBe(true);
    expect(wikiJobProcess.isRunning()).toBe(true);

    await vi.waitFor(() => {
      expect(mocks.generate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        workDir: '/tmp/repo',
        locale: 'zh',
      });
    });

    await vi.waitFor(() => {
      expect(wikiJobProcess.isRunning()).toBe(false);
    });
  });

  it('rejects a second job while one is active', async () => {
    let resolveGenerate!: () => void;
    mocks.generate.mockImplementationOnce(() => new Promise((resolve) => {
      resolveGenerate = () => resolve({ snapshotId: 'snap-2', status: 'completed' });
    }));

    expect(wikiJobProcess.start({
      kind: 'generate',
      projectId: 'proj-1',
      workDir: '/tmp/repo',
    })).toBe(true);

    expect(wikiJobProcess.start({
      kind: 'generate',
      projectId: 'proj-2',
      workDir: '/tmp/other',
    })).toBe(false);

    resolveGenerate();
    await vi.waitFor(() => expect(wikiJobProcess.isRunning()).toBe(false));
  });
});
