import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../../lib/config/config-types.js';
import { mcpLaunchConfig } from './mcp-launch-config.js';

export function createMcpTransport(
  config: McpServerConfig,
  workspace?: string,
): Transport {
  if (config.transport === 'http') {
    const url = new URL(config.url ?? '');
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Use an HTTP(S) MCP URL without embedded credentials');
    // MCP endpoints may intentionally be local/private. The endpoint is configured
    // explicitly by the user, never supplied by an agent tool invocation.
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: config.headers, redirect: 'error' },
    });
  }
  return new StdioClientTransport({
    ...mcpLaunchConfig(config, workspace),
    stderr: 'pipe',
  });
}
