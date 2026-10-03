import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWorkspaceRoot } from '../../project-workspace.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), open: vi.fn(), roots: vi.fn(), prompt: vi.fn(),
  session: { id: 'multi-root-session', sessionMetadata: null as Record<string, unknown> | null },
}));
vi.mock('../../acp/protocol/acp-connection.js', () => ({
  spawnAcpConnection: mocks.spawn, openAcpSession: mocks.open,
  initializeProtocol: vi.fn(async () => ({ capabilities: { loadSession: true } })),
  resolveSpawnForProvider: vi.fn(() => ({ providerId: 'codex-acp', command: 'codex-acp', args: [] })),
  resolveSpawnForProviderAsync: vi.fn(), cancelAcpPrompt: vi.fn(), closeAcpSession: vi.fn(), setAcpSessionModel: vi.fn(),
}));
vi.mock('../../acp/protocol/reverse-handlers.js', () => ({
  createWorkspaceClientHandlerForSession: (_root: string, _id: string, handler: unknown) => handler,
}));
vi.mock('../session-store.js', () => ({ agentRuntimeStore: {
  getSession: () => mocks.session,
  updateSession: (_id: string, patch: Record<string, unknown>) => Object.assign(mocks.session, patch),
} }));
vi.mock('../tools/workspace.js', () => ({
  resolveSessionWorkDir: () => '/primary', resolveSessionWorkspaceRoots: mocks.roots,
}));
vi.mock('../acp-engine/acp-permission-bridge.js', () => ({ acpPermissionBridge: { handleRequest: vi.fn() } }));
import { acpConnectionPool } from '../acp-engine/acp-connection-pool.js';
const input = { synaxSessionId: 'multi-root-session', projectId: 'project', providerId: 'codex-acp' as const };
const primary: ProjectWorkspaceRoot = { id: 'main', name: 'Main', path: '/primary', role: 'primary', status: 'available' };
const reference = (name: string): ProjectWorkspaceRoot => ({ id: name, name, path: `/${name}`, role: 'reference', status: 'available' });

beforeEach(() => {
  vi.clearAllMocks(); mocks.session.sessionMetadata = null;
  mocks.roots.mockReturnValue([primary, reference('a'), reference('b')]);
  mocks.spawn.mockImplementation(() => ({
    conn: { prompt: mocks.prompt },
    child: { exitCode: null, signalCode: null, killed: false }, cleanup: vi.fn(),
  }));
  mocks.open.mockResolvedValue({ sessionId: 'native-session' });
  mocks.prompt.mockResolvedValue({ stopReason: 'end_turn' });
});
afterEach(async () => { await acpConnectionPool.evict(input.synaxSessionId); });

describe('ACP workspace membership', () => {
  it('reuses reordered roots and rebuilds on additions and removals', async () => {
    const first = await acpConnectionPool.acquire(input);
    expect(mocks.open).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cwd: '/primary', additionalDirectories: ['/a', '/b'] }));
    mocks.roots.mockReturnValue([reference('b'), primary, reference('a')]);
    expect(await acpConnectionPool.acquire(input)).toBe(first);
    mocks.roots.mockReturnValue([primary, reference('a'), reference('b'), reference('c')]);
    const added = await acpConnectionPool.acquire(input);
    expect(added).not.toBe(first); expect(first.connection.cleanup).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ acpSessionId: 'native-session', additionalDirectories: ['/a', '/b', '/c'] }));
    mocks.roots.mockReturnValue([primary]);
    const removed = await acpConnectionPool.acquire(input);
    expect(removed).not.toBe(added); expect(added.connection.cleanup).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    expect(mocks.open).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ additionalDirectories: [] }));
    await removed.connection.conn.prompt({ sessionId: 'native-session', prompt: [{ type: 'text', text: 'continue' }] });
    const context = mocks.prompt.mock.calls.at(-1)![0].prompt[0].text;
    expect(context).toContain('/primary');
    expect(context).not.toContain('"/a"');
  });

  it('preserves the provider binding even when references changed', async () => {
    const first = await acpConnectionPool.acquire(input);
    mocks.roots.mockReturnValue([primary, reference('different')]);
    await expect(acpConnectionPool.acquire({ ...input, providerId: 'opencode-acp' })).rejects.toThrow(/backend/i);
    expect(first.connection.cleanup).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects a replacement native identity during workspace reconnection', async () => {
    await acpConnectionPool.acquire(input);
    mocks.roots.mockReturnValue([primary]);
    mocks.open.mockResolvedValue({ sessionId: 'replacement-session' });
    await expect(acpConnectionPool.acquire(input)).rejects.toThrow(/original native session/);
    expect(mocks.session.sessionMetadata).toMatchObject({ acp: { acpSessionId: 'native-session' } });
  });

  it('adds directory context without losing media blocks or mutating the request', async () => {
    const pooled = await acpConnectionPool.acquire(input);
    const request = { sessionId: 'native-session', prompt: [{ type: 'image' as const, data: 'abc', mimeType: 'image/png' }] };
    await pooled.connection.conn.prompt(request);
    expect(mocks.prompt).toHaveBeenCalledWith({ sessionId: 'native-session', prompt: [
      { type: 'text', text: expect.stringContaining('not instruction sources') }, ...request.prompt,
    ] });
    expect(request.prompt).toHaveLength(1);
    expect(pooled.additionalDirectories).toEqual(['/a', '/b']);
  });
});
