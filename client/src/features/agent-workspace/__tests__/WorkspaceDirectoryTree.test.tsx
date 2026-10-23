import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceDirectoryTree } from '../WorkspaceDirectoryTree';
import { projectApi, type ProjectWorkspaceRoot, type WorkspaceTreeListing } from '../../../adapters/transport/project';
import { useAgentSessionStore } from '../state/agentSessionStore';
import { useSessionWorkspaceStore } from '../state/sessionWorkspaceStore';
import { useShellStore } from '../../../shared/state/shellStore';
import { agentRuntimeApi, type WorkspaceRepositoryGit } from '../../../adapters/transport/agentRuntime';
import { invalidateWorkspaceGit, loadWorkspaceGit, resetSessionWorkspaceGit } from '../workspaceGitStore';
vi.mock('../../../adapters/transport/project', () => ({ projectApi: { getWorkspace: vi.fn(), listWorkspaceTree: vi.fn(), workspaceTreeStatus: vi.fn() } }));
vi.mock('../../../adapters/transport/agentRuntime', () => ({ agentRuntimeApi: { getWorkspaceGitChanges: vi.fn() } }));
vi.mock('../../../adapters/transport/runtimeEventBus', () => ({ subscribe: () => () => {} }));
const roots: ProjectWorkspaceRoot[] = [
  { id: 'p', name: 'Synax', path: '/repo', role: 'primary', status: 'available' },
  { id: 'ref', name: 'API', path: '/api', role: 'reference', status: 'available' },
];
const page = (rootId = 'p', path = '', entries: WorkspaceTreeListing['entries'] = []): WorkspaceTreeListing => ({
  projectId: 'p', rootId, rootName: rootId, rootPath: '/repo', path, entries, revision: 1, nextCursor: null, truncated: false,
});
beforeEach(() => {
  vi.resetAllMocks();
  useShellStore.setState(s => ({ preferences: { ...s.preferences, locale: 'zh' } }));
  useAgentSessionStore.setState({ selectedSessionId: null, sessions: [] });
  useSessionWorkspaceStore.setState({ sessions: {} });
  invalidateWorkspaceGit();
  resetSessionWorkspaceGit('p', 's');
  vi.mocked(agentRuntimeApi.getWorkspaceGitChanges).mockResolvedValue({ projectId: 'p', revision: 'empty', repositories: [], refreshedAt: '', unchanged: false });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({ roots });
  vi.mocked(projectApi.workspaceTreeStatus).mockResolvedValue({ revision: 1, indexing: false });
  vi.mocked(projectApi.listWorkspaceTree).mockImplementation(async (_, options) => page(options?.rootId, options?.path));
});

const git = (rootId: string, workspacePath: string, files: Array<{ path: string; untracked: boolean }>): WorkspaceRepositoryGit => ({
  rootId, name: rootId, role: 'primary', status: 'ready', workspacePath, branch: 'main', headCommitSha: 'abc',
  dirty: files.length > 0, additions: 0, deletions: 0, unpushedCommitCount: 0, revision: JSON.stringify(files),
  changedFiles: files.map(file => ({ ...file, status: file.untracked ? 'untracked' : 'modified', staged: false, additions: 0, deletions: 0 })),
});

it('loads shared Git counts without a session, aggregates descendants and updates collapsed directories', async () => {
  vi.mocked(agentRuntimeApi.getWorkspaceGitChanges).mockResolvedValue({ projectId: 'p', revision: 'counts-1', refreshedAt: '', unchanged: false, repositories: [
    git('p', '/repo', [{ path: 'src/app.ts', untracked: false }, { path: 'src/deep/new.ts', untracked: true }, { path: 'src-other/file.ts', untracked: false }]),
    git('ref', '/api', [{ path: 'handler.ts', untracked: true }]),
  ] });
  vi.mocked(projectApi.listWorkspaceTree).mockImplementation(async (_, o) => page(o?.rootId, o?.path,
    o?.rootId === 'p' ? [{ name: 'src', path: 'src', kind: 'directory', hasChildren: true }] : []));
  const view = render(<WorkspaceDirectoryTree projectId="p" />);
  const source = await screen.findByRole('button', { name: 'src', exact: true });
  await waitFor(() => expect(within(source).getByTitle('未跟踪 1 个文件')).toBeVisible());
  expect(within(source).getByTitle('未提交 1 个文件')).toBeVisible();
  expect(source).toHaveAttribute('aria-expanded', 'false');
  expect(within(screen.getByRole('button', { name: 'Synax', exact: true })).getByTitle('未提交 2 个文件')).toBeVisible();
  const api = screen.getByRole('button', { name: 'API', exact: true });
  expect(within(api).getByTitle('未跟踪 1 个文件')).toBeVisible();
  expect(api.querySelector('.workspace-git-count-badge--uncommitted')).toBeNull();
  expect(agentRuntimeApi.getWorkspaceGitChanges).toHaveBeenCalledWith('p', expect.objectContaining({ sessionId: undefined }));

  vi.mocked(agentRuntimeApi.getWorkspaceGitChanges).mockResolvedValue({ projectId: 'p', revision: 'counts-2', refreshedAt: '', unchanged: false,
    repositories: [git('p', '/repo', []), git('ref', '/api', [])] });
  await act(async () => { await loadWorkspaceGit('p'); });
  expect(view.container.querySelector('.workspace-git-count-badges')).toBeNull();
});

it('does not show another checkout’s counts for the selected session directory', async () => {
  useAgentSessionStore.setState({ selectedSessionId: 's', sessions: [{ id: 's', projectId: 'p' }] as never });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({ roots: [{ ...roots[0], path: '/new-tree' }] });
  vi.mocked(agentRuntimeApi.getWorkspaceGitChanges).mockResolvedValue({ projectId: 'p', revision: 'old-tree', refreshedAt: '', unchanged: false,
    repositories: [git('p', '/repo', [{ path: 'old.ts', untracked: false }])] });
  const view = render(<WorkspaceDirectoryTree projectId="p" />);
  await screen.findByRole('button', { name: 'Synax' });
  await waitFor(() => expect(agentRuntimeApi.getWorkspaceGitChanges).toHaveBeenCalledWith('p', expect.objectContaining({ sessionId: 's' })));
  expect(view.container.querySelector('.workspace-git-count-badges')).toBeNull();
});
afterEach(() => vi.useRealTimers());
it('renders all project roots inside the tree, collapses roots, and has no refresh or title dropdown', async () => {
  render(<WorkspaceDirectoryTree projectId="p" />);
  const tree = screen.getByRole('navigation', { name: '工作区目录树' });
  const root = await within(tree).findByRole('button', { name: 'Synax' });
  expect(within(tree).getByRole('button', { name: 'API' })).toBeTruthy();
  expect(root).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(root);
  expect(root).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: /刷新/ })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('loads directories on expansion and opens a file in the matching root', async () => {
  useAgentSessionStore.setState({ selectedSessionId: 's', sessions: [{ id: 's', projectId: 'p' }] as never });
  vi.mocked(projectApi.listWorkspaceTree).mockImplementation(async (_, o) => page(o?.rootId, o?.path,
    o?.path === 'src' ? [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', hasChildren: false }]
    : o?.rootId === 'p' ? [{ name: 'src', path: 'src', kind: 'directory', hasChildren: true }] : []));
  render(<WorkspaceDirectoryTree projectId="p" />);
  expect(await screen.findByRole('button', { name: 'src' })).toBeTruthy();
  expect(projectApi.listWorkspaceTree).not.toHaveBeenCalledWith('p', expect.objectContaining({ path: 'src' }));
  fireEvent.click(screen.getByRole('button', { name: 'src' }));
  fireEvent.click(await screen.findByRole('button', { name: 'app.ts' }));
  expect(useSessionWorkspaceStore.getState().sessions.s.tabs[0]).toMatchObject({ path: 'src/app.ts', rootId: 'p' });
  expect(projectApi.getWorkspace).toHaveBeenCalledWith('p', 's');
  expect(screen.getByRole('button', { name: 'app.ts' }).querySelector('[data-file-type-icon="app.ts"]')).toHaveClass('file-type-icon');
});
it('requests continuation pages and restarts on a stale cursor', async () => {
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({ roots: [roots[0]] });
  vi.mocked(projectApi.listWorkspaceTree)
    .mockResolvedValueOnce({ ...page('p', '', [{ name: 'first', path: 'first', kind: 'file', hasChildren: false }]), nextCursor: 'cursor', truncated: true })
    .mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409 }))
    .mockResolvedValueOnce(page('p', '', [{ name: 'replacement', path: 'replacement', kind: 'file', hasChildren: false }]));
  render(<WorkspaceDirectoryTree projectId="p" />);
  fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('button', { name: 'replacement' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'first' })).toBeNull();
  expect(projectApi.listWorkspaceTree).toHaveBeenLastCalledWith('p', expect.objectContaining({ cursor: undefined, limit: 100 }));
});
it('discards an old workspace response after project switching', async () => {
  let finish!: (value: { roots: ProjectWorkspaceRoot[] }) => void;
  vi.mocked(projectApi.getWorkspace).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ roots: [{ ...roots[0], id: 'other', name: 'Other' }] });
  const view = render(<WorkspaceDirectoryTree projectId="p" />);
  view.rerender(<WorkspaceDirectoryTree projectId="other" />);
  await screen.findByRole('button', { name: 'Other' });
  await act(async () => finish({ roots }));
  expect(screen.queryByRole('button', { name: 'Synax' })).toBeNull();
});
it('automatically revalidates visible directory pages when the Rust revision changes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({ roots: [roots[0]] });
  render(<WorkspaceDirectoryTree projectId="p" />);
  await waitFor(() => expect(projectApi.listWorkspaceTree).toHaveBeenCalledTimes(1));
  vi.mocked(projectApi.workspaceTreeStatus).mockResolvedValue({ revision: 2, indexing: false });
  vi.mocked(projectApi.listWorkspaceTree).mockResolvedValue({ ...page('p', '', [{ name: 'new.ts', path: 'new.ts', kind: 'file', hasChildren: false }]), revision: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(await screen.findByRole('button', { name: 'new.ts' })).toBeTruthy();
});
