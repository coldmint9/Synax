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
    snapshotAuthoritative: sidecar.snapshot,
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

  it('uses the sidecar cursor for durable snapshots', async () => {
    const { session } = sessionRun();
    sidecar.snapshot.mockResolvedValue({
      epoch: 1,
      revision: 1,
      activeRunId: `run-${session.id}`,
      cursor: 88,
      retainedFrom: 1,
    });

    const snapshot = await runtimeJournal.snapshotDurable(session.id);
    expect(snapshot.cursor).toBe(88);
    expect(sidecar.snapshot).toHaveBeenCalledWith(session.id);
  });

  it('hydrates every retained page up to the captured cursor, not only the first 256 events', async () => {
    const { session, run } = sessionRun();
    const step = { id: 'step', runId: run.id, sessionId: session.id, index: 1, completedAt: null };
    const steps = vi.spyOn(agentRuntimeStore, 'listRunSteps').mockReturnValue([step] as never);
    sidecar.snapshot.mockResolvedValue({ epoch: 1, revision: 1, activeRunId: run.id, cursor: 600, retainedFrom: 1 });
    const events = Array.from({ length: 602 }, (_, index) => ({
      sequence: index + 1, runId: run.id,
      payload: new TextEncoder().encode(JSON.stringify({ schema: 1,
        state: { status: 'running', activeRunId: run.id, pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-16T00:00:00Z' },
        chunk: { type: 'message_delta', runId: run.id, stepId: 'step', delta: String(index + 1) },
      })),
    }));
    sidecar.replay.mockImplementation(async (_id, after) => events.filter(event => event.sequence > after));
    try {
      const snapshot = await runtimeJournal.snapshotDurable(session.id);
      expect(snapshot.cursor).toBe(600);
      expect(snapshot.liveChunks).toHaveLength(601);
      expect(snapshot.liveChunks.at(-1)).toMatchObject({ delta: '600' });
      expect(sidecar.replay).toHaveBeenCalledTimes(3);
    } finally { steps.mockRestore(); }
  });
});
