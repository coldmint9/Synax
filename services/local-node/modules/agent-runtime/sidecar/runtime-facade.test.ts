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

it('uses only Rust regardless of retired transport flags', () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_SUPERVISOR', '1');
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', '');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('authoritative');
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'disabled');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('authoritative');
});
it('awaits the store commit before reading the created projection', async () => {
  const flush = vi.spyOn(agentRuntimeStore, 'flushSession').mockResolvedValue();
  const client = remote({ uiSnapshot: vi.fn(async()=>encode(snapshot)), seedUi: vi.fn() });
  await new RuntimeFacade(()=>client).ensureUiProjection('s');
  expect(flush).toHaveBeenCalledWith('s');
  expect(client.uiSnapshot).toHaveBeenCalledWith('s');
  expect(client.seedUi).not.toHaveBeenCalled();
});
it('does not hide failures or attempt SQL fallback when Rust already owns the projection', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL read'); });
  const client = remote({ uiSnapshot: vi.fn(async () => { throw new RuntimeSidecarError({ type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'storage unavailable' }); }) });
  await expect(new RuntimeFacade(() => client).uiSnapshotAuthoritative('s')).rejects.toThrow('storage unavailable');
  expect(read).not.toHaveBeenCalled();
});

it('leaves missing projections missing instead of seeding from a local working set', async () => {
  const client = remote({uiSnapshot:vi.fn().mockRejectedValue(new RuntimeSidecarError({type:'error',code:'PROJECTION_MISSING',message:'missing'})),seedUi:vi.fn()});
  await expect(new RuntimeFacade(()=>client).ensureUiProjection('s')).rejects.toMatchObject({code:'PROJECTION_MISSING'});
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

it('does not rescan SQLite history after an authoritative terminal finish', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const reads = [
    vi.spyOn(agentRuntimeStore, 'listMessages'),
    vi.spyOn(agentRuntimeStore, 'listRuns'),
    vi.spyOn(agentRuntimeStore, 'listToolCalls'),
    vi.spyOn(agentRuntimeStore, 'listEvents'),
  ];
  const run = { id: 'r', sessionId: 's', status: 'completed', completedAt: '2026-10-17T00:00:00.000Z', currentStep: 1, metadata: {} } as never;
  const client = remote({
    snapshot: vi.fn(async () => ({ epoch: 1, revision: 2 })),
    finishRun: vi.fn().mockResolvedValue({ epoch: 1, revision: 3 }),
    historyCommand: vi.fn().mockResolvedValue(encode({ revision: 1 })),
  });
  await new RuntimeFacade(() => client).finishExecution('s', run);
  expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);
});

it('waits for pending work or context history writes before authoritative finish', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const facade = new RuntimeFacade(() => remote({
    snapshot: vi.fn(async () => ({ epoch: 1, revision: 2 })),
    finishRun: vi.fn().mockResolvedValue({ epoch: 1, revision: 3 }),
    historyCommand: vi.fn(async () => { await gate; return encode({ revision: 1 }); }),
  }));
  const pending = facade.persistHistoryObject('s', 'runtime.work', { id: 'w', sessionId: 's', status: 'active' });
  let finished = false;
  const finish = facade.finishExecution('s', { id: 'r', sessionId: 's', status: 'completed', completedAt: '2026-10-17T00:00:00Z', currentStep: 1, metadata: {} } as never).then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await pending;
  await finish;
  expect(finished).toBe(true);
});

it('does not seed a missing projection from legacy SQL during a read', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL'); });
  const client = remote({ uiSnapshot: vi.fn().mockRejectedValue(new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MISSING', message: 'missing' })), seedUi: vi.fn() });
  await expect(new RuntimeFacade(() => client).uiSnapshotAuthoritative('s')).rejects.toMatchObject({ code: 'PROJECTION_MISSING' });
  expect(read).not.toHaveBeenCalled();
  expect(client.seedUi).not.toHaveBeenCalled();
});

it('publishes history entities in a single Rust append command without a Node head read/replace race', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const historyCommand = vi.fn().mockResolvedValue(encode({ revision: 1 }));
  const facade = new RuntimeFacade(() => remote({ historyCommand }));
  const record = { id: 'tool', sessionId: 's', status: 'completed' };
  await facade.persistHistoryObject('s', 'runtime.tool_call', record);
  expect(historyCommand).toHaveBeenCalledOnce();
  expect(historyCommand).toHaveBeenCalledWith({
    sessionId: 's', requestId: expect.stringMatching(/^history-append:[a-f0-9]{64}$/),
    operation: 'append_entities', payload: { objects: [{ kind: 'runtime.tool_call', value: record }] },
  });
  const original = historyCommand.mock.calls[0][0].requestId;
  await facade.persistHistoryObject('s', 'runtime.tool_call', record);
  expect(historyCommand.mock.calls[1][0].requestId).toBe(original);
  historyCommand.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(facade.persistHistoryObject('s', 'runtime.tool_call', record)).rejects.toThrow('disk unavailable');
});

it('keeps stream history batches within the control frame and refuses oversized entities explicitly', async () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_STREAM', 'authoritative');
  const historyCommand = vi.fn().mockResolvedValue(encode({ revision: 1 }));
  const facade = new RuntimeFacade(() => remote({ historyCommand }));
  const chunks = Array.from({ length: 300 }, (_, index) => ({ type: 'message', message: { id: `m-${index}`, sessionId: 's', content: 'x'.repeat(4_000) } }));
  await facade.persistStreamHistory('s', chunks as never);
  expect(historyCommand.mock.calls.length).toBeGreaterThan(1);
  const requests = historyCommand.mock.calls.map(([input]) => input);
  expect(requests.every(input => input.operation === 'append_entities' && input.payload.objects.length <= 256 && Buffer.byteLength(JSON.stringify(input.payload)) < 1024 * 1024)).toBe(true);
  expect(requests.flatMap(input => input.payload.objects).length).toBe(300);
  await expect(facade.persistHistoryObject('s', 'runtime.message', { id: 'large', sessionId: 's', content: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({ code: 'HISTORY_ENTITY_TOO_LARGE' });
});
