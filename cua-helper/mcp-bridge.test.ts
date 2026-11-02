import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(), clientClose: vi.fn(),
  clientCallTool: vi.fn(),
  serverConnect: vi.fn(), serverClose: vi.fn(), transportClose: vi.fn(),
  stderr: undefined as EventEmitter | undefined,
  handlers: [] as Array<[
    unknown,
    (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
      Promise<{ isError?: boolean; content?: unknown }>,
  ]>,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.clientConnect;
    close = mocks.clientClose;
    callTool = mocks.clientCallTool;
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
    setRequestHandler = (
      schema: unknown,
      handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
        Promise<{ isError?: boolean; content?: unknown }>,
    ) => {
      mocks.handlers.push([schema, handler]);
    };
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startCuaHelperBridge } from './mcp-bridge.js';
import { KEYCHAIN_FREE_ARG } from './keychain-policy.js';
const options = { mcp: { command: 'driver', args: [], environment: [] }, generation: 'test' };

beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of [mocks.clientConnect, mocks.clientClose, mocks.serverConnect, mocks.serverClose, mocks.transportClose])
    fn.mockResolvedValue(undefined);
  mocks.clientCallTool.mockResolvedValue({ content: [] });
  mocks.handlers.length = 0;
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

function callToolHandler() {
  const entry = mocks.handlers.find(([schema]) => schema === CallToolRequestSchema);
  if (!entry) throw new Error('CallTool handler was not registered');
  return entry[1];
}

describe('Cua helper keychain guard', () => {
  it('refuses driver-owned browser launches without calling the driver', async () => {
    const bridge = await startCuaHelperBridge(options);
    const result = await callToolHandler()({
      params: { name: 'browser_prepare', arguments: { allow_launch: true } },
    });
    expect(result.isError).toBe(true);
    expect(mocks.clientCallTool).not.toHaveBeenCalled();
    await bridge.close();
  });

  it('adds the keychain-free flag to isolated Chrome launches', async () => {
    const bridge = await startCuaHelperBridge(options);
    await callToolHandler()({
      params: {
        name: 'launch_app',
        arguments: {
          bundle_id: 'com.google.Chrome',
          additional_arguments: ['--user-data-dir=/tmp/automation-profile'],
        },
      },
    });
    expect(mocks.clientCallTool).toHaveBeenCalledWith({
      name: 'launch_app',
      arguments: {
        bundle_id: 'com.google.Chrome',
        additional_arguments: ['--user-data-dir=/tmp/automation-profile', KEYCHAIN_FREE_ARG],
      },
    });
    await bridge.close();
  });

  it('refuses Chrome launches that would reuse the real profile', async () => {
    const bridge = await startCuaHelperBridge(options);
    const result = await callToolHandler()({
      params: { name: 'launch_app', arguments: { bundle_id: 'com.google.Chrome' } },
    });
    expect(result.isError).toBe(true);
    expect(mocks.clientCallTool).not.toHaveBeenCalled();
    await bridge.close();
  });

  it('forwards other tools untouched', async () => {
    const bridge = await startCuaHelperBridge(options);
    await callToolHandler()({ params: { name: 'screenshot' } });
    expect(mocks.clientCallTool).toHaveBeenCalledWith({ name: 'screenshot', arguments: {} });
    await bridge.close();
  });

  it('lets the opt-out switch re-enable driver launches', async () => {
    process.env.SYNAX_CUA_ALLOW_BROWSER_LAUNCH = '1';
    try {
      const bridge = await startCuaHelperBridge(options);
      await callToolHandler()({
        params: { name: 'browser_prepare', arguments: { allow_launch: true } },
      });
      expect(mocks.clientCallTool).toHaveBeenCalledWith({
        name: 'browser_prepare',
        arguments: { allow_launch: true },
      });
      await bridge.close();
    } finally {
      delete process.env.SYNAX_CUA_ALLOW_BROWSER_LAUNCH;
    }
  });
});
