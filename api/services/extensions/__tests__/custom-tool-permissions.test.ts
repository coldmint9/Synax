import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  saveCustomExtension,
  changeExtensionState,
} from '../extension-service.js';
import { extensionStore } from '../extension-store.js';
import { buildCustomTool } from '../custom-tool-provider.js';
import { toolRegistry } from '../../agent-runtime/tool-registry.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import { resetAgentRuntimeFixtures } from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';
import {
  ensureSynaxAgentRegistered,
  SYNAX_AGENT_PROFILE_ID,
} from '../../agent-runtime/synax/index.js';
import * as exec from '../../agent-runtime/tools/exec-async.js';
import { getRawSqlite } from '../../../db/index.js';
afterEach(() => {
  vi.restoreAllMocks();
  getRawSqlite()
    .prepare(
      "DELETE FROM extension_definitions WHERE project_id = 'project-alpha'",
    )
    .run();
});
describe('custom command boundaries', () => {
  it('passes JSON on stdin to a real child process', async () => {
    resetAgentRuntimeFixtures();
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'explorer',
      prompt: 'Inspect',
    });
    const definition = saveCustomExtension('project-alpha', {
      kind: 'tool',
      name: 'Echo JSON',
      description: 'Echo input',
      tool: {
        mode: 'command',
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(require("node:fs").readFileSync(0,"utf8"))',
        ],
        inputSchema: { type: 'object' },
      },
    });
    const result = await buildCustomTool(definition, 'project-alpha').execute({
      sessionId: session.id,
      args: { text: '$(echo not-a-shell)' },
    } as any);
    expect(result.result).toMatchObject({
      ok: true,
      stdout: '{"text":"$(echo not-a-shell)"}',
    });
  });
  it('asks permission before custom commands run and blocks removed tools on resume', async () => {
    resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: SYNAX_AGENT_PROFILE_ID,
      prompt: 'Run checks',
    });
    const run = vi.spyOn(exec, 'runCommand');
    const definition = saveCustomExtension('project-alpha', {
      kind: 'tool',
      name: 'Checks',
      description: 'Run checks',
      tool: {
        mode: 'command',
        command: process.execPath,
        args: ['--version'],
        inputSchema: { type: 'object' },
      },
    });
    const result = await toolRegistry.execute(session.id, definition.id, {});
    expect(result.permission?.action).toBe('ask');
    expect(run).not.toHaveBeenCalled();
    changeExtensionState('project-alpha', 'tool', definition.id, 'uninstall');
    expect(() => toolRegistry.getForSession(session.id, definition.id)).toThrow(
      'removed or disabled',
    );
    await expect(
      toolRegistry.resumePending(session.id, {
        ...result.permission!,
        action: 'allow',
      }),
    ).rejects.toThrow('removed or disabled');
    expect(extensionStore.active('project-alpha', 'tool', definition.id)).toBe(
      false,
    );
  });
});

it('calls a configured local HTTP tool with bounded JSON input', async () => {
  const { createServer } = await import('node:http');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({
    projectId: 'project-alpha',
    profileId: 'explorer',
    prompt: 'Inspect',
  });
  let received = '';
  const server = createServer(async (request, response) => {
    for await (const chunk of request) received += chunk.toString();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ result: 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const definition = saveCustomExtension('project-alpha', {
      kind: 'tool',
      name: 'Local API',
      description: 'Call a configured local service',
      tool: {
        mode: 'http',
        url: `http://127.0.0.1:${address.port}/tool`,
        inputSchema: { type: 'object' },
      },
    });
    const tool = buildCustomTool(definition, 'project-alpha');
    expect(tool.category).toBe('mcp');
    const result = await tool.execute({
      sessionId: session.id,
      args: { query: 'hello' },
    } as any);
    expect(received).toBe('{"query":"hello"}');
    expect(result.result).toMatchObject({
      ok: true,
      status: 200,
      text: '{"result":"ok"}',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
