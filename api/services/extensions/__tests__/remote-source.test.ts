import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRawSqlite } from '../../../db/index.js';
import * as http from '../../skills/skill-http.js';
import { saveRemoteSource, remoteCatalogItems } from '../remote-source.js';
import { listExtensions } from '../extension-catalog.js';
import {
  installExtension,
  changeExtensionState,
} from '../extension-service.js';
import { extensionStore } from '../extension-store.js';
import { resetAgentRuntimeFixtures } from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
  getRawSqlite()
    .prepare("DELETE FROM extension_remote_sources WHERE id = 'catalog/test'")
    .run();
  getRawSqlite()
    .prepare(
      "DELETE FROM extension_definitions WHERE source_id = 'catalog/test'",
    )
    .run();
});
describe('unified remote catalog', () => {
  it('indexes tools, skills and MCP in one source without starting code', async () => {
    resetAgentRuntimeFixtures();
    vi.spyOn(http, 'fetchSkillText').mockResolvedValue(
      JSON.stringify({
        extensions: [
          {
            id: 'check',
            definition: {
              kind: 'tool',
              name: 'Check',
              description: 'Run checks',
              tool: {
                mode: 'command',
                command: 'node',
                args: ['check.js'],
                inputSchema: { type: 'object' },
              },
            },
          },
          {
            id: 'guide',
            version: '1.1.0',
            definition: {
              kind: 'skill',
              name: 'Guide',
              description: 'Team guide',
              content: 'Follow the team conventions.',
            },
          },
          {
            id: 'docs',
            definition: {
              kind: 'mcp',
              name: 'Docs',
              description: 'Documentation',
              mcp: {
                id: 'docs',
                name: 'Docs',
                command: '',
                transport: 'http',
                url: 'https://example.com/mcp',
              },
            },
          },
        ],
      }),
    );
    await saveRemoteSource({
      id: 'test',
      name: 'Team extensions',
      url: 'https://example.com/extensions.json',
    });
    const items = remoteCatalogItems('project-alpha');
    expect(items.map((item) => item.kind)).toEqual(['tool', 'skill', 'mcp']);
    expect(items.every((item) => !item.installed)).toBe(true);
    const result = await listExtensions('project-alpha', {
      view: 'market',
      source: 'catalog/test',
      kind: 'tool',
    });
    expect(result.items).toHaveLength(1);
    const tool = result.items[0]!;
    await installExtension('project-alpha', { id: tool.id, kind: tool.kind });
    expect(
      extensionStore.definition('project-alpha', 'tool', tool.id)?.tool
        ?.command,
    ).toBe('node');
    expect(
      remoteCatalogItems('other-project').find((item) => item.id === tool.id)
        ?.installed,
    ).toBe(false);
    changeExtensionState('project-alpha', 'tool', tool.id, 'uninstall');
    await installExtension('project-alpha', { id: tool.id, kind: tool.kind });
    expect(extensionStore.active('project-alpha', 'tool', tool.id)).toBe(true);
    getRawSqlite()
      .prepare('DELETE FROM project_extensions WHERE extension_id = ?')
      .run(tool.id);
  });
  it('rejects ambiguous catalog identifiers before changing the source', async () => {
    const entry = {
      id: 'duplicate',
      definition: {
        kind: 'skill',
        name: 'A',
        description: 'A guide',
        content: 'Text',
      },
    };
    vi.spyOn(http, 'fetchSkillText').mockResolvedValue(
      JSON.stringify({ extensions: [entry, entry] }),
    );
    await expect(
      saveRemoteSource({
        id: 'test',
        name: 'Bad source',
        url: 'https://example.com/extensions.json',
      }),
    ).rejects.toThrow('Duplicate');
  });
});
