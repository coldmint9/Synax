import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeFacade } from './runtime-facade.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { agentRuntimeStore } from '../session-store.js';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const snapshot = { session: { id: 's', status: 'completed' }, run: null, cursor: 1400, liveChunks: [], completedStepIds: ['step'] };
const remote = (overrides: object) => overrides as unknown as RuntimeSidecarClient;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('does not reconcile a conflicting fork request against a different committed receipt', async () => {
  const conflict = new RuntimeSidecarError({ type: 'error', code: 'REQUEST_CONFLICT', message: 'changed input' });
  const client = remote({ historyCommandGlobal: vi.fn(async () => encode({ copied: 1 })) });
  const facade = new RuntimeFacade(() => client);
  vi.spyOn(facade, 'historyCommandGlobal').mockResolvedValue({ copied: 1 });
  vi.spyOn(facade, 'historyCommand').mockRejectedValue(conflict);
  const status = vi.spyOn(facade, 'forkCopyResult');
  const release = vi.spyOn(facade, 'releaseForkAssets');
  await expect(facade.cloneHistoryAuthoritative({ sourceSessionId: 's', targetSessionId: 'copy', checkpointId: 'p', revision: 1, requestId: 'request' })).rejects.toBe(conflict);
  expect(status).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
});
it('reads a persisted projection without touching legacy session storage', async () => {
  const read = vi.spyOn(agentRuntimeStore, 'getSession').mockImplementation(() => { throw new Error('unexpected SQL read'); });
  const client = remote({ uiSnapshot: vi.fn(async () => encode(snapshot)), seedUi: vi.fn() });
  const facade = new RuntimeFacade(() => client);
  expect(await facade.uiSnapshotAuthoritative('s')).toEqual(snapshot);
  expect(read).not.toHaveBeenCalled(); expect(client.seedUi).not.toHaveBeenCalled();
});

it('uses only Rust regardless of retired transport flags', () => {
  vi.stubEnv('SYNAX_RUNTIME_SIDECAR_SUPERVISOR', '1');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('authoritative');
  expect(new RuntimeFacade(() => null).streamMode()).toBe('authoritative');
});

it('projects cache, aggregate usage, and context composition from sidecar history', async () => {
  const step = {
    id: 'step-1',
    sessionId: 's',
    runId: 'run-1',
    index: 0,
    status: 'completed',
    model: 'deepseek-flash',
    startedAt: '2026-10-17T00:00:00.000Z',
    completedAt: '2026-10-17T00:00:01.000Z',
    finishReason: 'stop',
    metadata: {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 50 },
      },
      contextComposition: {
        version: 2,
        messages: 20,
        tools: 10,
        mcp: 5,
        skills: 5,
        system: 0,
        total: 40,
        measuredAt: '2026-10-17T00:00:01.000Z',
      },
    },
  };
  const data: Record<string, unknown[]> = {
    list_runs: [{
      id: 'run-1', sessionId: 's', status: 'completed',
      startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:00:01.000Z',
    }],
    list_steps: [step],
    list_tool_calls: [{ id: 'tool-1', sessionId: 's' }],
    list_work: [],
    list_aux_usage: [],
  };
  const client = remote({
    uiSnapshot: vi.fn(async () => encode({
      session: { id: 's', status: 'completed', parentSessionId: null },
      run: null, cursor: 1, liveChunks: [], completedStepIds: ['step-1'],
    })),
    sessionList: vi.fn(async () => encode({
      items: [{ id: 's', parentSessionId: null }],
    })),
    historyCommand: vi.fn(async (input: { operation: string }) =>
      encode({ items: data[input.operation] ?? [] })),
  });

  const stats = await new RuntimeFacade(() => client).sessionStatsAuthoritative('s');
  expect((stats.cache as { latest: { ratio: number } }).latest.ratio).toBe(0.5);
  expect((stats.cache as { session: { weightedRatio: number } }).session.weightedRatio).toBe(0.5);
  expect((stats.usage as { self: { input: number; output: number } }).self).toMatchObject({ input: 100, output: 20 });
  expect(stats.contextComposition).toMatchObject({ total: 40 });
});

it('awaits the store commit before reading the created projection', async () => {
  const flush = vi.spyOn(agentRuntimeStore, 'flushSession').mockResolvedValue();
  const client = remote({ uiSnapshot: vi.fn(async()=>encode(snapshot)), seedUi: vi.fn() });
  await new RuntimeFacade(()=>client).ensureUiProjection('s');
  expect(flush).toHaveBeenCalledWith('s');
  expect(client.uiSnapshot).toHaveBeenCalledWith('s');
  expect(client.seedUi).not.toHaveBeenCalled();
});

it('does not flush or read the UI projection for process lease mirrors', async () => {
  const client = remote({
    snapshot: vi.fn(async () => ({ epoch: 1, revision: 2 })),
    controlCommand: vi.fn(async () => ({ stateJson: encode({}) })),
  });
  const facade = new RuntimeFacade(() => client);
  const ensure = vi.spyOn(facade, 'ensureUiProjection');
  await facade.controlCommand({
    sessionId: 's',
    requestId: 'lease:something:lease_open:none',
    operation: 'lease_open',
    payload: { leaseId: 'something' },
  });
  expect(ensure).not.toHaveBeenCalled();
  expect(client.snapshot).toHaveBeenCalledOnce();
  expect(client.controlCommand).toHaveBeenCalledOnce();
});

it('shares concurrent reads of the same history collection', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const historyCommand = vi.fn(async () => {
    await gate;
    return encode({ items: [{ id: 'tool-1', sessionId: 's' }] });
  });
  const facade = new RuntimeFacade(() => remote({ historyCommand }));
  const first = facade.listHistoryObjects('s', 'list_tool_calls');
  const second = facade.listHistoryObjects('s', 'list_tool_calls');
  await Promise.resolve();
  expect(historyCommand).toHaveBeenCalledOnce();
  release();
  await expect(Promise.all([first, second])).resolves.toEqual([
    [{ id: 'tool-1', sessionId: 's' }],
    [{ id: 'tool-1', sessionId: 's' }],
  ]);
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
  const updateRun = vi.spyOn(agentRuntimeStore, 'updateRun').mockImplementation(() => { throw new Error('must not write local run'); });
  const updateSession = vi.spyOn(agentRuntimeStore, 'updateSession').mockImplementation(() => { throw new Error('must not write local session'); });
  const run = { id: 'r', sessionId: 's', status: 'failed', completedAt: '2026-10-16T12:00:00.123Z', currentStep: 4, stopReason: 'provider error' } as never;
  const finishRun = vi.fn().mockResolvedValue({ epoch: 2, revision: 3, cursor: 10 });
  const historyCommand = vi.fn().mockResolvedValue(encode({ revision: 1 }));
  const client = remote({ snapshot: vi.fn(async () => ({ epoch: 1, revision: 2 })), uiSnapshot: vi.fn(async () => encode({ ...snapshot, session: { id: "s", status: "failed" } })), finishRun, historyCommand });
  const facade = new RuntimeFacade(() => client);
  await facade.finishExecution('s', run);
  expect(finishRun).toHaveBeenCalledWith({ sessionId: 's', requestId: 'finish:r', runId: 'r', status: 'failed', epoch: 1, revision: 2, run });
  expect(historyCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', operation: 'append_entities' }));
  finishRun.mockRejectedValueOnce(new Error('fsync unavailable'));
  await expect(facade.finishExecution('s', run)).rejects.toThrow('fsync unavailable');
  expect(updateRun).not.toHaveBeenCalled(); expect(updateSession).not.toHaveBeenCalled();
});

it('does not rescan SQLite history after an authoritative terminal finish', async () => {
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

it('keeps history frames bounded and uploads large entities through verified blobs', async () => {
  const historyCommand = vi.fn().mockResolvedValue(encode({ revision: 1 }));
  const facade = new RuntimeFacade(() => remote({ historyCommand }));
  const chunks = Array.from({ length: 300 }, (_, index) => ({ type: 'message', message: { id: `m-${index}`, sessionId: 's', content: 'x'.repeat(4_000) } }));
  await facade.persistStreamHistory('s', chunks as never);
  expect(historyCommand.mock.calls.length).toBeGreaterThan(1);
  const requests = historyCommand.mock.calls.map(([input]) => input);
  expect(requests.every(input => input.operation === 'append_entities' && input.payload.objects.length <= 256 && Buffer.byteLength(JSON.stringify(input.payload)) < 1024 * 1024)).toBe(true);
  expect(requests.flatMap(input => input.payload.objects).length).toBe(300);
  const beforeUpload = requests.length;
  await facade.persistHistoryObject('s', 'runtime.message', { id: 'large', sessionId: 's', content: 'x'.repeat(800 * 1024) });
  const uploaded = historyCommand.mock.calls.slice(beforeUpload).map(([input]) => input);
  expect(uploaded.map(input => input.operation)).toContain('put_blob_chunk');
  expect(uploaded.map(input => input.operation)).toContain('put_blob_manifest');
  expect(uploaded.map(input => input.operation)).toContain('append_entities_blob');
  expect(uploaded.every(input => Buffer.byteLength(JSON.stringify(input.payload)) < 768 * 1024)).toBe(true);
  await expect(facade.persistHistoryObject('s', 'runtime.message', { id: 'too-large', sessionId: 's', content: 'x'.repeat(5 * 1024 * 1024) })).rejects.toThrow('4 MiB');

});

it('returns one history page and forwards opaque incremental cursors without hydrating all collections', async () => {
  const rawCursor = { sessionId: 's', generation: 1, after: 's/73/changes/0001/~' };
  const historyCommand = vi.fn(async () => encode({
    messages: [{id:'m', content:'new'}], runs:[], steps:[], toolCalls:[], events:[], permissions:[], removed:[],
    historyWindow: { revision:2, epoch:1, generation:1, syncCursor:rawCursor, olderCursor:rawCursor, incremental:true },
  }));
  const facade = new RuntimeFacade(() => remote({ historyCommand }));
  const all = vi.spyOn(facade, 'listHistoryObjects');
  const since = Buffer.from(JSON.stringify(rawCursor)).toString('base64url');
  const result = await facade.historyWindowAuthoritative('s', undefined, since);
  expect(historyCommand).toHaveBeenCalledOnce();
  expect(historyCommand).toHaveBeenCalledWith(expect.objectContaining({ operation:'history_sync', payload:{cursor:undefined, since:rawCursor} }));
  expect(all).not.toHaveBeenCalled();
  expect(result.historyWindow.syncCursor).toBe(since);
  expect(result.messages).toEqual([{id:'m',content:'new'}]);
});
