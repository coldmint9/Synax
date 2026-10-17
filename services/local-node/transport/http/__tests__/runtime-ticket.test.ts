import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentSessionRuntime } from '../../../modules/agent-runtime/session-runtime.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
import { RuntimeSidecarError } from '../../../modules/agent-runtime/sidecar/sidecar-client.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';

beforeEach(resetAgentRuntimeFixtures);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const request = (sessionId: string, body: unknown) => agentRuntimeRoutes.request(`/sessions/${sessionId}/runtime-ticket`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
it('returns a no-store ticket only for an existing desktop authoritative session', async () => {
  vi.stubEnv('SYNAX_DESKTOP_SIDECAR', '1');
  vi.spyOn(runtimeFacade, 'streamMode').mockReturnValue('authoritative');
  const session = agentSessionRuntime.create(plannerSessionInput);
  vi.spyOn(runtimeFacade, 'uiSnapshotAuthoritative').mockImplementation(async (id) => {
    if (id !== session.id) throw new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MISSING', message: 'missing' });
    return { session, run: null, cursor: 0, liveChunks: [], completedStepIds: [] };
  });
  const read = vi.spyOn(runtimeFacade, 'ensureUiProjection').mockResolvedValue(undefined);
  const issue = vi.spyOn(runtimeFacade, 'uiTicket').mockResolvedValue({ url: 'ws://127.0.0.1:34567/runtime', token: 'short', expiresAtMs: Date.now() + 30000, clientId: 'window1', sessionId: session.id, protocol: 'synax.runtime.v2' });
  const response = await request(session.id, { clientId: 'window1', snapshot: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ transport: 'rust', ticket: { token: 'short' } });
  expect(body).not.toHaveProperty('snapshot');
  expect(issue).toHaveBeenCalledWith(session.id, 'window1'); expect(read).not.toHaveBeenCalled();
  await request(session.id, { clientId: 'window1', snapshot: false });
  expect(read).not.toHaveBeenCalled();
  issue.mockClear();
  expect((await request('missing', { clientId: 'window1' })).status).toBe(404);
  expect((await request(session.id, { clientId: '' })).status).toBe(400);
  expect(issue).not.toHaveBeenCalled();
});
it('does not expose loopback discovery to the remote web transport', async () => {
  vi.stubEnv('SYNAX_DESKTOP_SIDECAR', '0');
  vi.spyOn(runtimeFacade, 'streamMode').mockReturnValue('authoritative');
  const issue = vi.spyOn(runtimeFacade, 'uiTicket');
  const session = agentSessionRuntime.create(plannerSessionInput);
  vi.spyOn(runtimeFacade, 'uiSnapshotAuthoritative').mockResolvedValue({ session, run: null, cursor: 0, liveChunks: [], completedStepIds: [] });
  expect(await (await request(session.id, { clientId: 'web' })).json()).toEqual({ transport: 'node' });
  expect(issue).not.toHaveBeenCalled();
});
