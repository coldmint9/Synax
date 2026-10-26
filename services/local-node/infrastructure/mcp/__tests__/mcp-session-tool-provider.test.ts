import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serverId: 'fixture',
  toolName: 'echo',
  callTool: vi.fn(async () => ({ ok: true, text: 'echoed' })),
  sessions: new Map<string, { projectId: string; sessionMetadata: Record<string, unknown> | null }>(),
}));

vi.mock('../../../modules/extensions/extension-store.js', () => ({ extensionStore: { active: () => true } }));
vi.mock('../../../modules/agent-runtime/turn-reference-state.js', () => ({ effectiveTurnMcpIds: () => [mocks.serverId] }));
vi.mock('../../../modules/agent-runtime/session-store.js', () => ({ agentRuntimeStore: {
  getSession: (id: string) => mocks.sessions.get(id) ?? { projectId: 'project-a', sessionMetadata: null },
  updateSessionMetadata: (id: string, patch: Record<string, unknown>) => {
    const session = mocks.sessions.get(id) ?? { projectId: 'project-a', sessionMetadata: null };
    session.sessionMetadata = { ...(session.sessionMetadata ?? {}), ...patch };
    mocks.sessions.set(id, session);
    return session;
  },
} }));
vi.mock('../../runtime/config/project-settings-store.js', () => ({ getProjectSettings: () => ({ mcpServers: [{ id: mocks.serverId }] }) }));
vi.mock('../runtime-cua-config.js', () => ({ CUA_SERVER_ID: 'builtin-cua-driver', getRuntimeCuaConfig: () => null }));
vi.mock('../mcp-client-manager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mcp-client-manager.js')>(),
  mcpClientManager: {
    getCachedTools: () => [{ name: mocks.toolName, inputSchema: { type: 'object' } }],
    isReady: () => true,
    callTool: mocks.callTool,
  },
}));

import { mcpClientManager } from '../mcp-client-manager.js';
import { mcpSessionToolProvider } from '../mcp-session-tool-provider.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.clear();
  mocks.sessions.set('session-a', { projectId: 'project-a', sessionMetadata: null });
  mocks.sessions.set('session-b', { projectId: 'project-a', sessionMetadata: null });
});

it.each([
  ['fixture', 'echo'],
  ['com.example.mcp', 'echo'],
  ['fixture', 'namespace/echo'],
  ['fixture', 'echo'.repeat(30)],
])('calls the original MCP target for server %s and tool %s', async (serverId, toolName) => {
  mocks.serverId = serverId;
  mocks.toolName = toolName;
  const [tool] = mcpSessionToolProvider.getTools('session-a');
  const args = { text: 'hello' };
  const abortSignal = new AbortController().signal;
  const result = await tool.execute({
    sessionId: 'session-a', runId: null, stepId: null, toolCallId: 'call-a',
    toolId: tool.id, category: tool.category, mutability: tool.mutability,
    args, abortSignal,
  });
  expect(result.result).toMatchObject({ ok: true, text: 'echoed' });
  expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith(serverId, toolName, args, 'project-a', 'session-a', abortSignal);
});

it('reuses discovered tool schemas and refreshes them when discovery replaces a tool', () => {
  const discovered = { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
  const cached = vi.spyOn(mcpClientManager, 'getCachedTools').mockReturnValue([discovered]);
  try {
    const [first] = mcpSessionToolProvider.getTools('session-a');
    const [next] = mcpSessionToolProvider.getTools('session-b');
    expect(next.inputSchema).toBe(first.inputSchema);
    cached.mockReturnValue([{ ...discovered, inputSchema: { type: 'object', properties: { count: { type: 'number' } } } }]);
    const [updated] = mcpSessionToolProvider.getTools('session-a');
    expect(updated.inputSchema).not.toBe(first.inputSchema);
    expect(updated.inputSchema?.parse({ count: 2 })).toEqual({ count: 2 });
  } finally { cached.mockRestore(); }
});

it('restores the last discovered tools from the session after an MCP cache reset', () => {
  const discovered = { name: 'echo', title: 'Echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
  const cached = vi.spyOn(mcpClientManager, 'getCachedTools').mockReturnValue([discovered]);
  const ready = vi.spyOn(mcpClientManager, 'isReady').mockReturnValue(true);
  try {
    const [first] = mcpSessionToolProvider.getTools('session-a');
    expect(first.id).toBe('mcp.fixture.echo');
    const persisted = mocks.sessions.get('session-a')?.sessionMetadata?.mcpToolDefinitions;
    expect(persisted).toMatchObject({ version: 1, servers: { fixture: [{ name: 'echo' }] } });

    cached.mockReturnValue([]);
    ready.mockReturnValue(false);
    const [restored] = mcpSessionToolProvider.getTools('session-a');
    expect(restored.id).toBe(first.id);
    expect(restored.inputSchema?.parse({ text: 'hello' })).toEqual({ text: 'hello' });
  } finally {
    cached.mockRestore();
    ready.mockRestore();
  }
});
