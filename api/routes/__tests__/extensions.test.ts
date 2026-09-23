import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extensionRoutes } from '../extensions.js';
import { getRawSqlite } from '../../db/index.js';
import { resetAgentRuntimeFixtures } from '../../services/agent-runtime/__tests__/agent-runtime-fixtures.js';
const project = 'project-alpha';
function request(path: string, body?: unknown, method = 'POST') {
  return extensionRoutes.request(
    `/${project}/extensions${path}`,
    body === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
}
beforeEach(resetAgentRuntimeFixtures);
afterEach(() => {
  getRawSqlite()
    .prepare('DELETE FROM project_extensions WHERE project_id = ?')
    .run(project);
  getRawSqlite()
    .prepare('DELETE FROM extension_definitions WHERE project_id = ?')
    .run(project);
});
describe('extensions API', () => {
  it('lists builtin tools with real lifecycle state', async () => {
    const listed = await request('?kind=tool');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(
      body.items.some((item: { id: string }) => item.id === 'file.read'),
    ).toBe(true);
    expect(
      (await request('/tool/file.read/state', { action: 'uninstall' })).status,
    ).toBe(200);
    expect(
      (await (await request('?kind=tool&q=file.read')).json()).items.some(
        (item: { id: string }) => item.id === 'file.read',
      ),
    ).toBe(false);
    expect(
      (await request('/install', { kind: 'tool', id: 'file.read' })).status,
    ).toBe(200);
    expect(
      (await (await request('?kind=tool&q=file.read')).json()).items.some(
        (item: { id: string }) => item.id === 'file.read',
      ),
    ).toBe(true);
  });
  it('validates custom schemas and persists valid configuration without running it', async () => {
    expect(
      (
        await request('/custom', {
          kind: 'tool',
          name: 'No config',
          description: 'Bad',
        })
      ).status,
    ).toBe(400);
    const response = await request('/custom', {
      kind: 'tool',
      name: 'Checks',
      description: 'Project checks',
      tool: {
        mode: 'command',
        command: 'do-not-execute-this-on-save',
        inputSchema: { type: 'object' },
      },
    });
    expect(response.status).toBe(201);
    const { definition } = await response.json();
    const detail = await request(`/tool/${encodeURIComponent(definition.id)}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).definition.tool.command).toBe(
      'do-not-execute-this-on-save',
    );
  });
  it('uses local discovery as a source and bounds scan input', async () => {
    const { items } = await (await request('/sources')).json();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'local', kind: 'local' }),
      ]),
    );
    expect(
      (
        await request(
          '/sources/local',
          { directories: Array(9).fill('/tmp') },
          'PUT',
        )
      ).status,
    ).toBe(400);
    expect((await request('?offset=-1')).status).toBe(400);
    expect(
      (await request('/tool/unknown/state', { action: 'disable' })).status,
    ).toBe(409);
  });
});
