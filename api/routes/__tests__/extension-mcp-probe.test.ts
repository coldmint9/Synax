import { afterEach, expect, it, vi } from 'vitest';
import { mcpRoutes } from '../mcp.js';
import { mcpClientManager } from '../../services/mcp/mcp-client-manager.js';
import { resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';
afterEach(() => vi.restoreAllMocks());
it('tests stdio MCP from the same workspace directory used by the runtime', async () => {
  resetAgentRuntimeFixtures();
  const probe = vi.spyOn(mcpClientManager, 'probe').mockResolvedValue({ ok: true, tools: [] });
  const response = await mcpRoutes.request('/test?projectId=project-alpha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'example', name: 'Example', command: 'node', args: ['server.js'] }) });
  expect(response.status).toBe(200);
  expect(probe).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd(), command: 'node', args: ['server.js'] }));
});
