import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, it } from 'vitest';
import { McpClientManager } from '../mcp-client-manager.js';

it('connects to a real Streamable HTTP MCP endpoint and lists tools', async () => {
  const http = createServer(async (request, response) => {
    const server = new McpServer({ name: 'test-http', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo input' }, async () => ({
      content: [{ type: 'text', text: 'hello' }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const manager = new McpClientManager();
  try {
    const result = await manager.probe({
      id: 'remote',
      name: 'Remote',
      command: '',
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    expect(result.ok).toBe(true);
    expect(result.tools.some((tool) => tool.name === 'echo')).toBe(true);
  } finally {
    manager.closeAll();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}, 15000);
