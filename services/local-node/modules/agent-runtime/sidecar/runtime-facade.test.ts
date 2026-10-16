import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeFacade } from './runtime-facade.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { agentRuntimeStore } from '../session-store.js';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const snapshot = { session: { id: 's', status: 'completed' }, run: null, cursor: 1400, liveChunks: [], completedStepIds: ['step'] };
const remote = (overrides: object) => overrides as unknown as RuntimeSidecarClient;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('reads a persisted projection without touching legacy session storage', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL read'); });
  const client = remote({ uiSnapshot: vi.fn(async () => encode(snapshot)), seedUi: vi.fn() });
  const facade = new RuntimeFacade(() => client);
  expect(await facade.uiSnapshotAuthoritative('s')).toEqual(snapshot);
  expect(read).not.toHaveBeenCalled(); expect(client.seedUi).not.toHaveBeenCalled();
});

it('defaults a supervised host to authoritative mode while allowing an explicit disabled test transport', () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_SUPERVISOR', '1');
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', '');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('authoritative');
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'disabled');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('disabled');
});
it('uses the persisted result of create-if-absent when another command wins seed initialization', async () => {
  const initial = { id: 's', projectId: 'p', status: 'running', updatedAt: 'now' };
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockReturnValue(initial as never);
  vi.spyOn(agentRuntimeStore, 'listRuns').mockReturnValue([]);
  const client = remote({
    uiSnapshot: vi.fn(async () => { throw new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MISSING', message: 'missing' }); }),
    seedUi: vi.fn(async () => encode(snapshot)),
  });
  expect(await new RuntimeFacade(() => client).uiSnapshotAuthoritative('s')).toEqual(snapshot);
  expect(read).toHaveBeenCalledOnce(); expect(client.seedUi).toHaveBeenCalledWith('s', Buffer.from(JSON.stringify(initial)));
});
it('does not hide failures or attempt SQL fallback when Rust already owns the projection', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL read'); });
  const client = remote({ uiSnapshot: vi.fn(async () => { throw new RuntimeSidecarError({ type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'storage unavailable' }); }) });
  await expect(new RuntimeFacade(() => client).uiSnapshotAuthoritative('s')).rejects.toThrow('storage unavailable');
  expect(read).not.toHaveBeenCalled();
});

it('does not seed an empty Rust projection over already executed SQLite history', async () => {
  vi.spyOn(agentRuntimeStore, 'getSession').mockReturnValue({ id: 's' } as never);
  vi.spyOn(agentRuntimeStore, 'listRuns').mockReturnValue([{ id: 'old', status: 'completed' }] as never);
  const client = remote({
    uiSnapshot: vi.fn(async () => { throw new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MISSING', message: 'missing' }); }),
    seedUi: vi.fn(),
  });
  await expect(new RuntimeFacade(() => client).uiSnapshotAuthoritative('s')).rejects.toMatchObject({ code: 'PROJECTION_MIGRATION_REQUIRED' });
  expect(client.seedUi).not.toHaveBeenCalled();
});

it('submits the terminal run document to Rust and propagates persistence failure without local writes', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const updateRun = vi.spyOn(agentRuntimeStore, 'updateRun').mockImplementation(() => { throw new Error('must not write local run'); });
  const updateSession = vi.spyOn(agentRuntimeStore, 'updateSession').mockImplementation(() => { throw new Error('must not write local session'); });
  const run = { id: 'r', sessionId: 's', status: 'failed', completedAt: '2026-10-16T12:00:00.123Z', currentStep: 4, stopReason: 'provider error' } as never;
  const finishRun = vi.fn().mockResolvedValue({ epoch: 2, revision: 3, cursor: 10 });
  const client = remote({ snapshot: vi.fn(async () => ({ epoch: 1, revision: 2 })), finishRun });
  const facade = new RuntimeFacade(() => client);
  await facade.finishExecution('s', run);
  expect(finishRun).toHaveBeenCalledWith({ sessionId: 's', requestId: 'finish:r', runId: 'r', status: 'failed', epoch: 1, revision: 2, run });
  finishRun.mockRejectedValueOnce(new Error('fsync unavailable'));
  await expect(facade.finishExecution('s', run)).rejects.toThrow('fsync unavailable');
  expect(updateRun).not.toHaveBeenCalled(); expect(updateSession).not.toHaveBeenCalled();
});
