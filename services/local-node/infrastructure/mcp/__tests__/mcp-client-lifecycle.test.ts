import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ connect: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn>; stderr: { resume: ReturnType<typeof vi.fn> } }>,
  listTools: undefined as (() => Promise<{ tools: Array<{ name: string }> }>) | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    listTools = vi.fn(() => mocks.listTools?.() ?? Promise.resolve({ tools: [{ name: 'echo' }] }));
    close = vi.fn(async () => undefined);
    constructor() { mocks.clients.push(this); }
  },
}));
vi.mock('../mcp-transport.js', () => ({
  createMcpTransport: () => {
    const transport = { close: vi.fn(async () => undefined), stderr: { resume: vi.fn() } };
    mocks.transports.push(transport);
    return transport;
  },
}));
vi.mock('../runtime-cua-config.js', () => ({
  CUA_SERVER_ID: 'builtin-cua-driver',
  getRuntimeCuaConfig: () => ({ id: 'builtin-cua-driver', command: 'fixture', enabled: true }),
}));
vi.mock('../../runtime/config/project-settings-store.js', () => ({ getProjectSettings: () => ({ mcpServers: [] }) }));
vi.mock('../../../modules/project-workspace.js', () => ({ readWorkspaceProject: () => undefined }));

import { McpClientManager } from '../mcp-client-manager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let manager: McpClientManager;
const cua = 'builtin-cua-driver';
const warmup = () => manager.warmup([cua], 'project-a', 'session-a');
const cached = () => manager.getCachedTools(cua, 'project-a', 'session-a');

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.transports.length = 0;
  mocks.listTools = undefined;
  manager = new McpClientManager();
});
afterEach(() => { manager.closeAll(); });

describe('MCP startup resource ownership', () => {
  it('shares one connection across concurrent warmups', async () => {
    await Promise.all(Array.from({ length: 12 }, warmup));
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.transports).toHaveLength(1);
    expect(mocks.transports[0].stderr.resume).toHaveBeenCalledOnce();
    expect(cached()).toEqual([expect.objectContaining({ name: 'echo' })]);
    manager.closeAll();
    expect(mocks.clients[0].close).toHaveBeenCalledOnce();
    expect(mocks.transports[0].close).toHaveBeenCalledOnce();
  });

  it.each(['server', 'cua', 'all'] as const)('reclaims an in-flight startup on close %s', async (scope) => {
    const listed = deferred<{ tools: Array<{ name: string }> }>();
    mocks.listTools = () => listed.promise;
    const startup = warmup();
    await vi.waitFor(() => expect(mocks.clients[0].listTools).toHaveBeenCalledOnce());
    if (scope === 'server') manager.closeServer(cua, 'project-a', 'session-a');
    else if (scope === 'cua') manager.closeCua();
    else manager.closeAll();
    expect(mocks.transports[0].close).toHaveBeenCalled();
    listed.resolve({ tools: [{ name: 'stale' }] });
    await startup;
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(cached()).toEqual([]);
  });

  it('prevents an old completion from replacing or untracking a new startup', async () => {
    const old = deferred<{ tools: Array<{ name: string }> }>();
    mocks.listTools = () => old.promise;
    const first = warmup();
    await vi.waitFor(() => expect(mocks.clients[0].listTools).toHaveBeenCalledOnce());
    manager.closeCua();
    const next = deferred<{ tools: Array<{ name: string }> }>();
    mocks.listTools = () => next.promise;
    const second = warmup();
    await vi.waitFor(() => expect(mocks.clients[1].listTools).toHaveBeenCalledOnce());
    old.resolve({ tools: [{ name: 'stale' }] });
    await first;
    const third = warmup();
    expect(mocks.clients).toHaveLength(2);
    next.resolve({ tools: [{ name: 'fresh' }] });
    await Promise.all([second, third]);
    expect(cached()).toEqual([expect.objectContaining({ name: 'fresh' })]);
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(mocks.clients[1].close).not.toHaveBeenCalled();
  });

  it('closes both client and transport when tool discovery fails', async () => {
    mocks.listTools = async () => { throw new Error('discovery failed'); };
    await warmup();
    expect(mocks.clients[0].close).toHaveBeenCalledOnce();
    expect(mocks.transports[0].close).toHaveBeenCalledOnce();
    expect(cached()).toEqual([]);
    mocks.listTools = undefined;
    await warmup();
    expect(mocks.clients).toHaveLength(2);
    expect(cached()).toHaveLength(1);
  });
});
