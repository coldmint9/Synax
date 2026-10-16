import { beforeEach, describe, expect, it, vi } from 'vitest';

const sidecar = vi.hoisted(() => ({
  mode: vi.fn(),
  replay: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('../sidecar/runtime-facade.js', () => ({
  runtimeFacade: {
    streamMode: sidecar.mode,
    replayAuthoritative: sidecar.replay,
    uiSnapshotAuthoritative: sidecar.snapshot,
  },
}));

import { runtimeJournal } from '../runtime-journal.js';
import { agentRuntimeStore } from '../session-store.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

function sessionRun() {
  const session = agentSessionRuntime.create(plannerSessionInput);
  const run = agentRuntimeStore.appendRun({
    id: `run-${session.id}`,
    sessionId: session.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    triggerMessageId: null,
    currentStep: 0,
    stopReason: null,
    model: null,
    metadata: {},
  });
  agentRuntimeStore.updateSession(session.id, { activeRunId: run.id, status: 'running' });
  return { session, run };
}

describe('authoritative sidecar runtime journal projection', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    sidecar.mode.mockReturnValue('authoritative');
    sidecar.replay.mockReset();
    sidecar.snapshot.mockReset();
  });

  it('projects sidecar payloads into the existing RuntimeStreamRecord shape', async () => {
    const { session, run } = sessionRun();
    const localEventsBefore = agentRuntimeStore.listEvents(session.id).length;
    sidecar.replay.mockResolvedValue([
      {
        sequence: 42,
        runId: run.id,
        payload: new TextEncoder().encode(JSON.stringify({
          schema: 1, state: { status: 'running', activeRunId: run.id, pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-16T00:00:00Z' },
          chunk: { type: 'message_delta',
          runId: run.id,
          stepId: 'step-sidecar',
          delta: 'from sidecar' },
        })),
      },
    ]);

    agentRuntimeStore.updateSession(session.id, { status: 'completed', activeRunId: null });
    const records = await runtimeJournal.readDurable(session.id, 0, 10, run.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sequence: 42,
      sessionId: session.id,
      runId: run.id,
      chunk: {
        type: 'message_delta',
        delta: 'from sidecar',
      },
      state: {
        activeRunId: run.id,
      },
    });
    expect(agentRuntimeStore.listEvents(session.id)).toHaveLength(localEventsBefore);
  });

  it('returns the persisted Rust snapshot without assembling state from SQLite or replay', async () => {
    const { session, run } = sessionRun();
    const materialized = { session, run, cursor: 1600, liveChunks: [], completedStepIds: ['step'] };
    sidecar.snapshot.mockResolvedValue(materialized);
    const getSession = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('SQL must not be read'); });
    const getSteps = vi.spyOn(agentRuntimeStore, 'listRunSteps').mockImplementation(() => { throw new Error('SQL steps must not be read'); });
    try {
      expect(await runtimeJournal.snapshotDurable(session.id)).toEqual(materialized);
      expect(sidecar.snapshot).toHaveBeenCalledWith(session.id);
      expect(sidecar.replay).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled(); expect(getSteps).not.toHaveBeenCalled();
    } finally { getSession.mockRestore(); getSteps.mockRestore(); }
  });

  it('propagates missing or invalid Rust snapshot failures without a SQL fallback', async () => {
    sidecar.snapshot.mockRejectedValue(new Error('offline migration required'));
    await expect(runtimeJournal.snapshotDurable('existing')).rejects.toThrow('offline migration required');
  });
});
