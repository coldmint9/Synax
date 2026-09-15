import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), initialize: vi.fn(), open: vi.fn(), permission: vi.fn(),
  session: { id: 'synax-session', sessionMetadata: null as Record<string, unknown> | null },
}));
vi.mock('../../acp/protocol/acp-connection.js', () => ({
  spawnAcpConnection: mocks.spawn, initializeProtocol: mocks.initialize, openAcpSession: mocks.open,
  resolveSpawnForProvider: vi.fn(() => ({ providerId: 'codex-acp', command: 'codex-acp', args: [] })),
  resolveSpawnForProviderAsync: vi.fn(), cancelAcpPrompt: vi.fn(), closeAcpSession: vi.fn(),
  setAcpSessionModel: vi.fn(),
}));
vi.mock('../../acp/protocol/reverse-handlers.js', () => ({ createWorkspaceClientHandlerForSession: (_root: string, _sessionId: string | null, handler: unknown) => handler }));
vi.mock('../session-store.js', () => ({ agentRuntimeStore: {
  getSession: () => mocks.session,
  updateSession: (_id: string, patch: Record<string, unknown>) => Object.assign(mocks.session, patch),
} }));
vi.mock('../tools/workspace.js', () => ({ resolveSessionWorkDir: () => '/tmp/synax-pool-test' }));
vi.mock('../acp-engine/acp-permission-bridge.js', () => ({ acpPermissionBridge: {
  handleRequest: mocks.permission, rejectAllForSession: vi.fn(), clearTurnContext: vi.fn(),
} }));
import { acpConnectionPool } from '../acp-engine/acp-connection-pool.js';

const input = { synaxSessionId: 'synax-session', projectId: 'project', providerId: 'codex-acp' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.sessionMetadata = null;
  mocks.spawn.mockReturnValue({
    conn: {}, child: { connected: false, exitCode: null, signalCode: null, killed: false },
    cleanup: vi.fn(), stderrChunks: [],
  });
  mocks.initialize.mockResolvedValue({ capabilities: { loadSession: true } });
  mocks.open.mockResolvedValue({ sessionId: 'native-session' });
});
afterEach(async () => { await acpConnectionPool.evict(input.synaxSessionId); });

describe('ACP connection lifecycle', () => {
  it('cancels an opening connection before spawning the host', async () => {
    const opening = acpConnectionPool.acquire(input);
    const evicted = acpConnectionPool.evict(input.synaxSessionId);
    await expect(opening).rejects.toThrow(/cancelled/i);
    await evicted;
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('closes a host which is still waiting for its handshake', async () => {
    let rejectHandshake!: (error: Error) => void;
    mocks.initialize.mockReturnValueOnce(new Promise((_, reject) => { rejectHandshake = reject; }));
    const cleanup = vi.fn(() => rejectHandshake(new Error('Handshake closed')));
    mocks.spawn.mockReturnValueOnce({ conn: {}, child: { exitCode: null, signalCode: null, killed: false }, cleanup });
    const opening = acpConnectionPool.acquire(input);
    const rejection = expect(opening).rejects.toThrow('Handshake closed');
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalled());
    await acpConnectionPool.evict(input.synaxSessionId);
    await rejection;
    expect(cleanup).toHaveBeenCalled();
    expect(acpConnectionPool.count()).toBe(0);
  });

  it('replaces an exited host without waiting on its own acquisition', async () => {
    const old = await acpConnectionPool.acquire(input);
    Object.assign(old.connection.child, { exitCode: 1 });
    mocks.spawn.mockReturnValueOnce({ conn: {}, child: { exitCode: null, signalCode: null, killed: false }, cleanup: vi.fn() });
    const reopened = await acpConnectionPool.acquire(input);
    expect(reopened).not.toBe(old);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('reuses a live stdio process without requiring a Node IPC channel', async () => {
    const first = await acpConnectionPool.acquire(input);
    expect(await acpConnectionPool.acquire(input)).toBe(first);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('routes permission callbacks using the owning Synax session identity', async () => {
    await acpConnectionPool.acquire(input);
    const handler = mocks.spawn.mock.calls[0]![0];
    const request = { sessionId: 'native-session', toolCall: {}, options: [] };
    await handler.requestPermission(request);
    expect(mocks.permission).toHaveBeenCalledWith(request, input.synaxSessionId);
  });

  it('does not keep fresh prompt output marked as historical replay after load finishes', async () => {
    mocks.session.sessionMetadata = { acp: { providerId: 'codex-acp', acpSessionId: 'native-session' } };
    const connection = await acpConnectionPool.acquire(input);
    expect(mocks.open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ acpSessionId: 'native-session' }));
    expect(connection.isReplay).toBe(false);
  });

  it('cleans up the child when session restoration fails', async () => {
    mocks.open.mockRejectedValueOnce(new Error('restore failed'));
    await expect(acpConnectionPool.acquire(input)).rejects.toThrow('restore failed');
    expect(mocks.spawn.mock.results[0]!.value.cleanup).toHaveBeenCalledTimes(1);
    expect(acpConnectionPool.count()).toBe(0);
  });
});
