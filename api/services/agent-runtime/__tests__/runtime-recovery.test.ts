import { beforeEach, describe, expect, it } from 'vitest';
import { recoverRuntime, acknowledgeRuntimeRecovery, restoreUnlaunchedInput } from '../runtime-recovery.js';
import { agentRuntimeStore } from '../session-store.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { acceptRuntimeRun } from '../run-admission.js';
import os from 'node:os';
beforeEach(resetAgentRuntimeFixtures);

describe('restart recovery decisions', () => {
  it('retains an unlaunched request for explicit continuation without automatically replaying it', async () => {
    const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: os.tmpdir() });
    const { run } = acceptRuntimeRun(session.id, { message: 'Exact pending input' }, 'pending');
    await recoverRuntime('new-host');
    expect(agentRuntimeStore.getRun(run.id).status).toBe('interrupted');
    expect(restoreUnlaunchedInput(session.id, {})).toMatchObject({ message: 'Exact pending input' });
  });
  it('requires explicit review for interrupted running work and does not fabricate completion', async () => {
    const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: os.tmpdir() });
    const { run } = acceptRuntimeRun(session.id, { message: 'Write something' }, 'running');
    agentRuntimeStore.updateRun(run.id, { status: 'running' });
    await recoverRuntime('new-host');
    expect(agentRuntimeStore.getSession(session.id).status).toBe('completed');
    expect(() => acceptRuntimeRun(session.id, { message: 'Next' }, 'next')).toThrow(/shutdown|recovery/i);
    await acknowledgeRuntimeRecovery(session.id);
    expect(agentRuntimeStore.getSession(session.id).status).toBe('interrupted');
    expect(agentRuntimeStore.getRun(run.id).status).toBe('interrupted');
  });
});
