import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamRun: vi.fn(async function* () {
    yield { type: 'done', sessionId: 'sess-1', runId: 'run-1' };
  }),
}));

vi.mock('../../agent-runtime/loop-runtime.js', () => ({
  agentLoopRuntime: {
    streamRun: (...args: unknown[]) => mocks.streamRun(...args),
  },
}));

vi.mock('../wiki-loop-profile.js', () => ({
  ensureWikiProfileRegistered: vi.fn(),
}));

vi.mock('../wiki-plan-profile.js', () => ({
  ensurePlanProfileRegistered: vi.fn(),
}));

vi.mock('../wiki-refresh-profile.js', () => ({
  ensureRefreshProfileRegistered: vi.fn(),
}));

import { ensureWikiProfileRegistered } from '../wiki-loop-profile.js';
import { streamWikiAgent } from '../wiki-agent-stream.js';

describe('streamWikiAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamRun.mockImplementation(async function* () {
      yield { type: 'done', sessionId: 'sess-1', runId: 'run-1' };
    });
  });

  it('runs in-process inside wiki job child (not via parent IPC)', async () => {
    process.env.SYNAX_WIKI_JOB_CHILD = '1';
    process.env.SYNAX_AGENT_SESSION_IN_PROCESS = '0';

    const chunks = [];
    for await (const chunk of streamWikiAgent('sess-1', { locale: 'zh' })) {
      chunks.push(chunk);
    }

    expect(ensureWikiProfileRegistered).toHaveBeenCalled();
    expect(mocks.streamRun).toHaveBeenCalledWith('sess-1', { locale: 'zh' }, undefined, false);
    expect(chunks).toHaveLength(1);
  });
});
