import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ command: vi.fn(), projects: vi.fn(), roots: vi.fn() }));
vi.mock('./agent-runtime/sidecar/runtime-facade.js', () => ({ runtimeFacade: { workspaceIndexCommand: mocks.command } }));
vi.mock('../infrastructure/runtime/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./project-workspace.js', () => ({ workspaceRootHostPath: (root: { path: string }) => root.path,
  projectWorkspaceRoots: mocks.roots, listWorkspaceProjects: mocks.projects }));
import { WorkspaceIndexService } from './workspace-index-service.js';
const root = { id: 'r', name: 'Repo', path: '/repo', role: 'primary' as const, status: 'available' as const };
beforeEach(() => { vi.resetAllMocks(); mocks.projects.mockReturnValue([{ id: 'p' }]); mocks.roots.mockReturnValue([root]); mocks.command.mockResolvedValue({ revision: 1, indexing: true }); });
it('starts persisted projects asynchronously without any frontend directory request', async () => {
  const service = new WorkspaceIndexService();
  service.start(); service.start();
  expect(mocks.command).not.toHaveBeenCalled();
  await new Promise(resolve => setImmediate(resolve));
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith('register', { hostPath: '/repo' });
});
it('coalesces roots and bounds registration concurrency without awaiting background scans', async () => {
  const service = new WorkspaceIndexService();
  let finish!: () => void;
  mocks.command.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  service.indexProject('p', [root, root, { ...root, id: 'b', path: '/other' }, { ...root, id: 'c', path: '/third' }]);
  expect(mocks.command).toHaveBeenCalledTimes(2);
  finish(); await new Promise(resolve => setImmediate(resolve));
  expect(mocks.command).toHaveBeenCalledTimes(3);
});
it('preserves paths and pagination while passing authorized roots to Rust', async () => {
  const service = new WorkspaceIndexService();
  mocks.command.mockResolvedValue({ path: ' leading /', entries: [], nextCursor: null, revision: 2 });
  expect(await service.listChildren({ projectId: 'p', root, relativePath: ' leading /', showHidden: true, showIgnored: true, cursor: 'c' }))
    .toMatchObject({ projectId: 'p', rootId: 'r', path: ' leading /', revision: 2 });
  expect(mocks.command).toHaveBeenCalledWith('list', { hostPath: '/repo', path: ' leading /', showHidden: true, showIgnored: true, cursor: 'c', limit: 100 });
});
it('does not fall back to Node when Rust is unavailable', async () => {
  const service = new WorkspaceIndexService();
  mocks.command.mockRejectedValue(new Error('sidecar unavailable'));
  await expect(service.listChildren({ projectId: 'p', root })).rejects.toThrow('sidecar unavailable');
  expect(mocks.command).toHaveBeenCalledOnce();
});
