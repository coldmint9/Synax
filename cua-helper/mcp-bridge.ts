import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface DriverMcpConfiguration {
  command: string;
  args: string[];
  environment: Array<{ name: string; value: string }>;
}

export interface CuaHelperBridgeOptions {
  /** Launch metadata returned by the embedded host for the driver's MCP server. */
  mcp: DriverMcpConfiguration;
  generation: string;
  /** Extra environment for the driver child; defaults to the helper process env. */
  environment?: Record<string, string>;
  onDriverStderr?: (line: string) => void;
}

export interface CuaHelperBridge {
  close(): Promise<void>;
}

function mergeEnvironment(
  inherited: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return { ...base, ...(extra ?? {}) };
}

/**
 * Expose the driver's MCP surface on the helper's own stdin/stdout.
 *
 * The helper is what Synax spawns, so the MCP session identity (and therefore the
 * lifecycle and permission story) belongs to this process. Tool definitions and
 * results are forwarded verbatim, including image content, so structured media
 * handling in the API layer keeps working.
 */
export async function startCuaHelperBridge(
  options: CuaHelperBridgeOptions,
): Promise<CuaHelperBridge> {
  const client = new Client(
    { name: 'synax-cua', version: '0.30.2' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: options.mcp.command,
    args: options.mcp.args,
    env: mergeEnvironment(process.env, options.environment),
    stderr: 'pipe',
  });
  await client.connect(transport);

  const driverStderr = transport.stderr;
  if (driverStderr && options.onDriverStderr) {
    let buffer = '';
    driverStderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) options.onDriverStderr?.(line);
    });
  }

  const server = new Server(
    { name: 'synax-cua', version: '0.30.2' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    client.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    }),
  );

  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

/** Generation is exposed to the driver so logs can be correlated per helper run. */
export function generationEnvironment(generation: string): Record<string, string> {
  return { SYNAX_CUA_GENERATION: generation };
}
