import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(), clientClose: vi.fn(),
  serverConnect: vi.fn(), serverClose: vi.fn(), transportClose: vi.fn(),
  stderr: undefined as EventEmitter | undefined,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.clientConnect;
    close = mocks.clientClose;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    stderr = mocks.stderr;
    close = mocks.transportClose;
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    connect = mocks.serverConnect;
    close = mocks.serverClose;
    setRequestHandler = vi.fn();
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

import { startCuaHelperBridge } from './mcp-bridge.js';
const options = { mcp: { command: 'driver', args: [], environment: [] }, generation: 'test' };

beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of [mocks.clientConnect, mocks.clientClose, mocks.serverConnect, mocks.serverClose, mocks.transportClose])
    fn.mockResolvedValue(undefined);
  mocks.stderr = new EventEmitter();
});
afterEach(() => vi.restoreAllMocks());

describe('Cua helper bridge cleanup', () => {
  it.each(['client', 'server'] as const)('closes all resources after %s connection failure', async (side) => {
    const error = new Error('connection failed');
    (side === 'client' ? mocks.clientConnect : mocks.serverConnect).mockRejectedValue(error);
    await expect(startCuaHelperBridge(options)).rejects.toBe(error);
    expect(mocks.clientClose).toHaveBeenCalledOnce();
    expect(mocks.serverClose).toHaveBeenCalledOnce();
    expect(mocks.transportClose).toHaveBeenCalledOnce();
  });

  it('keeps cleanup idempotent and closes the transport even when client.close fails', async () => {
    const bridge = await startCuaHelperBridge(options);
    mocks.clientClose.mockRejectedValue(new Error('close failed'));
    await Promise.all([bridge.close(), bridge.close()]);
    expect(mocks.clientClose).toHaveBeenCalledOnce();
    expect(mocks.serverClose).toHaveBeenCalledOnce();
    expect(mocks.transportClose).toHaveBeenCalledOnce();
  });

  it('bounds an unterminated stderr line', async () => {
    const onDriverStderr = vi.fn();
    const bridge = await startCuaHelperBridge({ ...options, onDriverStderr });
    for (let i = 0; i < 100; i++) mocks.stderr!.emit('data', Buffer.alloc(4096, 'x'));
    mocks.stderr!.emit('data', Buffer.from('\n'));
    expect(onDriverStderr).toHaveBeenCalledOnce();
    expect(onDriverStderr.mock.calls[0][0]).toHaveLength(16_384);
    await bridge.close();
  });

  it('drains diagnostics without a logging callback', async () => {
    const bridge = await startCuaHelperBridge(options);
    expect(mocks.stderr!.listenerCount('data')).toBe(1);
    await bridge.close();
  });
});
