import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentRuntimeStore } from '../../../modules/agent-runtime/session-store.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
import { RuntimeSidecarError } from '../../../modules/agent-runtime/sidecar/sidecar-client.js';

const checkpoints = [
  { id: 'first', objectId: 'o1', metadata: { kind: 'input', messageId: 'm0' } },
  { id: 'middle', objectId: 'o2', metadata: { kind: 'reply', messageId: 'm32', stepId: 'step' } },
  { id: 'latest', objectId: 'o3', metadata: { kind: 'reply', messageId: 'm64' } },
];

beforeEach(() => {
  vi.spyOn(agentRuntimeStore, 'hydrateSessions').mockResolvedValue();
  vi.spyOn(agentRuntimeStore, 'hydrateSession').mockResolvedValue();
  vi.spyOn(agentRuntimeStore, 'flush').mockResolvedValue();
  vi.spyOn(runtimeFacade, 'uiSnapshotAuthoritative').mockResolvedValue({ session: { id: 's', status: 'running' } } as never);
  vi.spyOn(runtimeFacade, 'sessionSummaryAuthoritative').mockResolvedValue({ id: 's', status: 'running' } as never);
  vi.spyOn(runtimeFacade, 'historyHeadAuthoritative').mockResolvedValue({ revision: 42 });
  vi.spyOn(runtimeFacade, 'listHistoryCheckpoints').mockResolvedValue(checkpoints);
  vi.spyOn(runtimeFacade, 'listMessageHistory').mockRejectedValue(new Error('must not drain all messages'));
  vi.spyOn(runtimeFacade, 'messageHistoryBoundsAuthoritative').mockResolvedValue({ firstMessageId: 'm0', lastMessageId: 'm64' });
  vi.spyOn(runtimeFacade, 'controlState').mockResolvedValue({ runtimeControl: { historyRequestId: 'recovery' } });
});
afterEach(() => vi.restoreAllMocks());

function request(messageIds?: unknown) {
  const query = messageIds === undefined ? '' : `?messageIds=${encodeURIComponent(JSON.stringify(messageIds))}`;
  return agentRuntimeRoutes.request(`http://localhost/sessions/s/checkpoints${query}`);
}

it('accepts a loaded transcript larger than 64 messages without losing its checkpoint actions', async () => {
  const response = await request(Array.from({ length: 65 }, (_, index) => `m${index}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    revision: 42, recoveryRequired: true, rollbackEnabled: true,
    checkpoints: [
      { id: 'first', initialInput: true, hasLaterHistory: true },
      { id: 'middle', initialInput: false, hasLaterHistory: true, stepId: 'step' },
      { id: 'latest', initialInput: false, hasLaterHistory: false },
    ],
  });
});

it('reads checkpoint metadata without loading the execution working set', async () => {
  vi.mocked(agentRuntimeStore.hydrateSessions).mockRejectedValue(new Error('must not load all sessions'));
  vi.mocked(agentRuntimeStore.hydrateSession).mockRejectedValue(new Error('must not drain history'));
  const response = await request(['m64']);
  expect(response.status).toBe(200);
  expect((await response.json()).checkpoints).toEqual([expect.objectContaining({ id: 'latest', hasLaterHistory: false })]);
  expect(agentRuntimeStore.hydrateSessions).not.toHaveBeenCalled();
  expect(agentRuntimeStore.hydrateSession).not.toHaveBeenCalled();
  expect(agentRuntimeStore.flush).not.toHaveBeenCalled();
  expect(runtimeFacade.listMessageHistory).not.toHaveBeenCalled();
});

it.each([null, {}, [1], [''], ['x'.repeat(257)]].map(ids => ({ ids })))('rejects invalid message IDs with 400: $ids', async ({ ids }) => {
  expect((await request(ids)).status).toBe(400);
  expect(runtimeFacade.listHistoryCheckpoints).not.toHaveBeenCalled();
});

it('rejects malformed query JSON with 400', async () => {
  const response = await agentRuntimeRoutes.request('http://localhost/sessions/s/checkpoints?messageIds=%5B');
  expect(response.status).toBe(400);
  expect(runtimeFacade.listHistoryCheckpoints).not.toHaveBeenCalled();
});

it('preserves empty and unfiltered query semantics', async () => {
  expect((await (await request([])).json()).checkpoints).toEqual([]);
  expect((await (await request()).json()).checkpoints).toHaveLength(3);
});

it.each(['archivedAt', 'deletedAt'])('keeps the %s session access guard', async (field) => {
  vi.mocked(runtimeFacade.sessionSummaryAuthoritative).mockResolvedValue({ id: 's', status: 'completed', sessionMetadata: { [field]: 'now' } } as never);
  expect((await request()).status).toBe(404);
  expect(runtimeFacade.listHistoryCheckpoints).not.toHaveBeenCalled();
});

it('reports a genuine storage failure instead of an empty successful response', async () => {
  vi.mocked(runtimeFacade.listHistoryCheckpoints).mockRejectedValue(new RuntimeSidecarError({
    type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'storage unavailable',
  }));
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});
