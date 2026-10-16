import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ start: vi.fn(async () => 3219), read: vi.fn(async () => 'private-api-token\n') }));
vi.mock('./node-sidecar.js', () => ({ startSidecar: mocks.start }));
vi.mock('./data-paths.js', () => ({ getDataRoot: () => '/isolated' }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.read }));
import { getRuntimeConnection } from './runtime-connection.js';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('keeps API credentials in main and returns only the short-lived connection descriptor', async () => {
  const descriptor = { transport: 'rust', ticket: { token: 'one-use-ticket' } };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => descriptor }));
  vi.stubGlobal('fetch', fetch);
  expect(await getRuntimeConnection('session', 'window', true)).toEqual(descriptor);
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3219/api/agent-runtime/sessions/session/runtime-ticket', expect.objectContaining({
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-api-token' },
    body: JSON.stringify({ clientId: 'window', snapshot: true }),
  }));
});
it('rejects malformed IPC arguments before starting a service or reading credentials', async () => {
  await expect(getRuntimeConnection({}, 'window', true)).rejects.toThrow('Invalid runtime connection');
  await expect(getRuntimeConnection('session', 'window', 'true')).rejects.toThrow('Invalid runtime connection');
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
});
