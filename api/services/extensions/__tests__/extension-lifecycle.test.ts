import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawSqlite } from '../../../db/index.js';
import { extensionStore } from '../extension-store.js';
import { installedCatalog, listExtensions } from '../extension-catalog.js';
import {
  changeExtensionState,
  installExtension,
  saveCustomExtension,
} from '../extension-service.js';
import {
  customToolProvider,
  buildCustomTool,
} from '../custom-tool-provider.js';
import { skillRegistry } from '../../skills/skill-registry.js';
import { toolRegistry } from '../../agent-runtime/tool-registry.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import {
  resetAgentRuntimeFixtures,
  explorerSessionInput,
} from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';
import { getProjectSettings } from '../../../lib/config/project-settings-store.js';
import { localExtensionSource } from '../local-source.js';
import * as execution from '../../agent-runtime/tools/exec-async.js';
import * as skillHttp from '../../skills/skill-http.js';
import { skillInstallService } from '../../skills/skill-install-service.js';

const projectId = 'project-alpha';
let temporary: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-extensions-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const definition of extensionStore.definitions(projectId, 'skill'))
    if (definition.skillPath)
      fs.rmSync(path.dirname(definition.skillPath), {
        recursive: true,
        force: true,
      });
  getRawSqlite()
    .prepare('DELETE FROM project_extensions WHERE project_id = ?')
    .run(projectId);
  getRawSqlite()
    .prepare('DELETE FROM extension_definitions WHERE project_id = ?')
    .run(projectId);
  extensionStore.setDirectories(projectId, []);
  fs.rmSync(temporary, { recursive: true, force: true });
});
describe('extension lifecycle', () => {
  it('detaches builtin tools from both listing and invocation and can restore them', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    changeExtensionState(projectId, 'tool', 'file.read', 'uninstall');
    expect(
      toolRegistry
        .listForSession(session.id)
        .some((tool) => tool.id === 'file.read'),
    ).toBe(false);
    await expect(
      toolRegistry.execute(session.id, 'file.read', { path: 'package.json' }),
    ).rejects.toThrow('removed or disabled');
    expect(
      installedCatalog(projectId).find((item) => item.id === 'file.read'),
    ).toMatchObject({ installed: false });
    await installExtension(projectId, { kind: 'tool', id: 'file.read' });
    expect(
      toolRegistry
        .listForSession(session.id)
        .some((tool) => tool.id === 'file.read'),
    ).toBe(true);
  });
  it('uninstalls builtin skills per project without deleting their files', async () => {
    const id = 'synax-builtin/synax-explore';
    const original = skillRegistry.getSummary(id, projectId);
    changeExtensionState(projectId, 'skill', id, 'uninstall');
    expect(() =>
      skillRegistry.loadDetail({ skillId: id, projectId }),
    ).toThrow();
    expect(skillRegistry.getSummary(id, 'other-project').installed).toBe(true);
    expect(fs.existsSync(original.installPath!)).toBe(true);
    await installExtension(projectId, { kind: 'skill', id });
    expect(
      skillRegistry.loadDetail({ skillId: id, projectId }).content,
    ).toBeTruthy();
  });
  it('creates and edits custom skills, preserves their version, and restores detached skills', async () => {
    const created = saveCustomExtension(projectId, {
      kind: 'skill',
      name: 'My review',
      description: 'Review carefully',
      content:
        '---\nname: my-review\ndescription: Review carefully\nmetadata:\n  version: 2.1.0\n---\nReview code.',
    });
    expect(skillRegistry.getSummary(created.id, projectId)).toMatchObject({
      installed: true,
      version: '2.1.0',
    });
    expect(() =>
      skillRegistry.getSummary(created.id, 'other-project'),
    ).toThrow();
    changeExtensionState(projectId, 'skill', created.id, 'disable');
    expect(() =>
      skillRegistry.loadDetail({ skillId: created.id, projectId }),
    ).toThrow();
    saveCustomExtension(projectId, {
      id: created.id,
      kind: 'skill',
      name: 'Review edited',
      description: 'Updated instructions',
      content: 'New instructions',
    });
    expect(extensionStore.state(projectId, 'skill', created.id).enabled).toBe(
      false,
    );
    changeExtensionState(projectId, 'skill', created.id, 'uninstall');
    await installExtension(projectId, { kind: 'skill', id: created.id });
    expect(
      skillRegistry.loadDetail({ skillId: created.id, projectId }).content,
    ).toBe('New instructions');
  });
  it('never executes custom commands during creation, scanning or installation', async () => {
    const run = vi.spyOn(execution, 'runCommand').mockResolvedValue({
      status: 0,
      stdout: 'done',
      stderr: '',
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutBytes: 4,
      stderrBytes: 0,
    });
    const definition = saveCustomExtension(projectId, {
      kind: 'tool',
      name: 'Project check',
      description: 'Run checks',
      tool: {
        mode: 'command',
        command: 'node',
        args: ['check.js'],
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    });
    const session = agentSessionRuntime.create(explorerSessionInput);
    expect(
      customToolProvider
        .getTools(session.id)
        .find((tool) => tool.id === definition.id)?.internalGate,
    ).toBe('shell');
    expect(run).not.toHaveBeenCalled();
    const tool = buildCustomTool(definition, projectId);
    await tool.execute({
      sessionId: session.id,
      args: { name: '$(do-not-execute)' },
    } as any);
    expect(run).toHaveBeenCalledWith(
      'node',
      ['check.js'],
      expect.objectContaining({ stdin: '{"name":"$(do-not-execute)"}' }),
    );
    changeExtensionState(projectId, 'tool', definition.id, 'uninstall');
    expect(
      customToolProvider
        .getTools(session.id)
        .some((tool) => tool.id === definition.id),
    ).toBe(false);
  });
  it('imports local tool manifests as catalog entries, never as executable discovery', async () => {
    fs.writeFileSync(
      path.join(temporary, 'synax-tools.json'),
      JSON.stringify({
        tools: [
          {
            name: 'Local check',
            description: 'Local tool',
            tool: {
              mode: 'command',
              command: 'node',
              args: ['check.js'],
              inputSchema: { type: 'object' },
            },
          },
        ],
      }),
    );
    extensionStore.setDirectories(projectId, [temporary]);
    const found = localExtensionSource(projectId).tools[0]!;
    expect(found.definition.name).toBe('Local check');
    await installExtension(projectId, {
      kind: 'tool',
      id: found.id,
      locator: {
        sourceId: 'local',
        name: 'Local check',
        discoveryId: found.id,
      },
    });
    expect(
      installedCatalog(projectId).find((item) => item.id === found.id),
    ).toMatchObject({ kind: 'tool', installed: true, sourceId: 'local' });
  });
  it('keeps newly downloaded skill packages scoped to the installing project', async () => {
    vi.spyOn(skillHttp, 'fetchSkillText').mockResolvedValue(
      '---\nname: extension-scoped-test\ndescription: Scoped package\n---\nScoped instructions',
    );
    const id = await installExtension(projectId, {
      kind: 'skill',
      id: 'default-remote/extension-scoped-test',
      locator: {
        sourceId: 'default-remote',
        name: 'extension-scoped-test',
        remoteUrl: 'https://example.com/skill.md',
      },
    });
    try {
      expect(skillRegistry.getSummary(id, projectId).installed).toBe(true);
      expect(() => skillRegistry.getSummary(id, 'other-project')).toThrow();
      changeExtensionState(projectId, 'skill', id, 'uninstall');
      await installExtension(projectId, { kind: 'skill', id });
      expect(skillRegistry.getSummary(id, projectId).installed).toBe(true);
    } finally {
      skillInstallService.uninstall(id);
    }
  });
  it('supports remote MCP config lifecycle without connecting on save', async () => {
    const definition = saveCustomExtension(projectId, {
      kind: 'mcp',
      name: 'Remote docs',
      description: 'Documentation MCP',
      mcp: {
        id: 'unused',
        name: 'Remote docs',
        command: '',
        transport: 'http',
        url: 'https://example.com/mcp',
      },
    });
    expect(
      getProjectSettings(projectId, true).mcpServers.find(
        (server) => server.id === definition.id,
      )?.transport,
    ).toBe('http');
    changeExtensionState(projectId, 'mcp', definition.id, 'disable');
    expect(
      getProjectSettings(projectId, true).mcpServers.find(
        (server) => server.id === definition.id,
      )?.enabled,
    ).toBe(false);
    changeExtensionState(projectId, 'mcp', definition.id, 'uninstall');
    expect(
      getProjectSettings(projectId, true).mcpServers.some(
        (server) => server.id === definition.id,
      ),
    ).toBe(false);
    await installExtension(projectId, { kind: 'mcp', id: definition.id });
    expect(
      getProjectSettings(projectId, true).mcpServers.find(
        (server) => server.id === definition.id,
      )?.enabled,
    ).toBe(true);
    changeExtensionState(projectId, 'mcp', definition.id, 'uninstall');
  });
  it('searches installed capabilities without contacting remote sources', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await listExtensions(projectId, {
      kind: 'tool',
      q: 'file.read',
    });
    expect(result.items.some((item) => item.id === 'file.read')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
