import { streamTurnRequestSchema } from '../contracts.js';
import { beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { acceptRuntimeRun, activateAcceptedRun } from '../run-admission.js';

beforeEach(resetAgentRuntimeFixtures);
const create = () => agentSessionRuntime.create({ ...plannerSessionInput, workDir: os.tmpdir() });

describe('durable Run admission', () => {
  it('does not accept an internal activation token from the public request schema', () => {
    expect(streamTurnRequestSchema.parse({ message: 'Read', acceptedRunId: 'forged' }))
      .toEqual({ message: 'Read' });
  });

  it('returns the same persisted Run for a repeated request without executing it', () => {
    const session = create();
    const first = acceptRuntimeRun(session.id, { message: 'Read README' }, 'request-a');
    const replay = acceptRuntimeRun(session.id, { message: 'Read README' }, 'request-a');
    expect(first.run.status).toBe('queued');
    expect(replay).toMatchObject({ reused: true, run: { id: first.run.id } });
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(1);
  });

  it('rejects reusing an idempotency key for different input', () => {
    const session = create();
    acceptRuntimeRun(session.id, { message: 'Read README' }, 'request-a');
    expect(() => acceptRuntimeRun(session.id, { message: 'Delete README' }, 'request-a')).toThrow(/different input/i);
  });

  it('allows only one accepted execution per session until the current Run settles', () => {
    const session = create();
    const first = acceptRuntimeRun(session.id, { message: 'one' }, 'one');
    expect(() => acceptRuntimeRun(session.id, { message: 'two' }, 'two')).toThrow(/active|queued/i);
    agentRuntimeStore.updateRun(first.run.id, { status: 'completed' });
    const second = acceptRuntimeRun(session.id, { message: 'two' }, 'two');
    expect(second.run.id).not.toBe(first.run.id);
  });

  it('activates the reserved Run exactly once instead of creating a second one', () => {
    const session = create();
    const { run } = acceptRuntimeRun(session.id, { message: 'Read' }, 'activate');
    const started = activateAcceptedRun(session.id, run.id, 'user-message', null);
    expect(started).toMatchObject({ id: run.id, status: 'running', triggerMessageId: 'user-message' });
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(1);
    expect(() => activateAcceptedRun(session.id, run.id, 'again', null)).toThrow(/queued|active/i);
  });

  it('rejects an activation under the wrong session identity', () => {
    const first = create(); const other = create();
    const { run } = acceptRuntimeRun(first.id, { message: 'Read' }, 'bound');
    expect(() => activateAcceptedRun(other.id, run.id, 'wrong', null)).toThrow(/session/i);
    expect(agentRuntimeStore.getRun(run.id).status).toBe('queued');
  });

  it('marks a queued execution interrupted on restart instead of silently replaying it', () => {
    const session = create();
    const accepted = acceptRuntimeRun(session.id, { message: 'Read' }, 'restart');
    agentRuntimeStore.recoverOrphanedSessions();
    expect(agentRuntimeStore.getRun(accepted.run.id).status).toBe('interrupted');
    expect(acceptRuntimeRun(session.id, { message: 'Read' }, 'restart')).toMatchObject({
      reused: true, run: { id: accepted.run.id, status: 'interrupted' },
    });
  });

  it('does not fall back to the server cwd when the execution workspace is missing', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    expect(() => acceptRuntimeRun(session.id, { message: 'Read' }, 'root')).toThrow(/workspace|directory/i);
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(0);
  });
});
