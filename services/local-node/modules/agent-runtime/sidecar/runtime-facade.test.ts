import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeFacade } from './runtime-facade.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { agentRuntimeStore } from '../session-store.js';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const snapshot = { session: { id: 's', status: 'completed' }, run: null, cursor: 1400, liveChunks: [], completedStepIds: ['step'] };
const remote = (overrides: object) => overrides as unknown as RuntimeSidecarClient;
afterEach(() => vi.restoreAllMocks());
it('reads a persisted projection without touching legacy session storage', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL read'); });
  const client = remote({ uiSnapshot: vi.fn(async () => encode(snapshot)), seedUi: vi.fn() });
  const facade = new RuntimeFacade(() => client);
  expect(await facade.uiSnapshotAuthoritative('s')).toEqual(snapshot);
  expect(read).not.toHaveBeenCalled(); expect(client.seedUi).not.toHaveBeenCalled();
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
