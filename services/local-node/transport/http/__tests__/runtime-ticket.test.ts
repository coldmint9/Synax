import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { agentSessionRuntime } from '../../../modules/agent-runtime/session-runtime.js';
import { runtimeJournal } from '../../../modules/agent-runtime/runtime-journal.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
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
  const snapshot = { session, run: null, cursor: 0, liveChunks: [], completedStepIds: [] };
  const read = vi.spyOn(runtimeJournal, 'snapshotDurable').mockResolvedValue(snapshot);
  const issue = vi.spyOn(runtimeFacade, 'uiTicket').mockResolvedValue({ url: 'ws://127.0.0.1:34567/runtime', token: 'short', expiresAtMs: Date.now() + 30000, clientId: 'window1', sessionId: session.id, protocol: 'synax.runtime.v2' });
  const response = await request(session.id, { clientId: 'window1', snapshot: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ transport: 'rust', snapshot: { cursor: 0 }, ticket: { token: 'short' } });
  expect(issue).toHaveBeenCalledWith(session.id, 'window1'); expect(read).toHaveBeenCalledOnce();
  await request(session.id, { clientId: 'window1', snapshot: false });
  expect(read).toHaveBeenCalledOnce();
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
  expect(await (await request(session.id, { clientId: 'web' })).json()).toEqual({ transport: 'node' });
  expect(issue).not.toHaveBeenCalled();
});
