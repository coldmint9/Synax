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
          type: 'message_delta',
          runId: run.id,
          stepId: 'step-sidecar',
          delta: 'from sidecar',
        })),
      },
    ]);

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
});
