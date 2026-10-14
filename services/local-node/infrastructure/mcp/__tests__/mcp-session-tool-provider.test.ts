import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serverId: 'fixture',
  toolName: 'echo',
  callTool: vi.fn(async () => ({ ok: true, text: 'echoed' })),
}));

vi.mock('../../../modules/extensions/extension-store.js', () => ({ extensionStore: { active: () => true } }));
vi.mock('../../../modules/agent-runtime/turn-reference-state.js', () => ({ effectiveTurnMcpIds: () => [mocks.serverId] }));
vi.mock('../../../modules/agent-runtime/session-store.js', () => ({ agentRuntimeStore: { getSession: () => ({ projectId: 'project-a' }) } }));
vi.mock('../../runtime/config/project-settings-store.js', () => ({ getProjectSettings: () => ({ mcpServers: [{ id: mocks.serverId }] }) }));
vi.mock('../runtime-cua-config.js', () => ({ CUA_SERVER_ID: 'builtin-cua-driver', getRuntimeCuaConfig: () => null }));
vi.mock('../mcp-client-manager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mcp-client-manager.js')>(),
  mcpClientManager: {
    getCachedTools: () => [{ name: mocks.toolName, inputSchema: { type: 'object' } }],
    callTool: mocks.callTool,
  },
}));

import { mcpClientManager } from '../mcp-client-manager.js';
import { mcpSessionToolProvider } from '../mcp-session-tool-provider.js';

beforeEach(() => { vi.clearAllMocks(); });

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
