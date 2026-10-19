import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceDirectoryTree } from '../WorkspaceDirectoryTree';
import { projectApi, type ProjectWorkspaceRoot, type WorkspaceTreeListing } from '../../../adapters/transport/project';
import { useAgentSessionStore } from '../state/agentSessionStore';
import { useSessionWorkspaceStore } from '../state/sessionWorkspaceStore';
import { useShellStore } from '../../../shared/state/shellStore';
vi.mock('../../../adapters/transport/project', () => ({ projectApi: { getWorkspace: vi.fn(), listWorkspaceTree: vi.fn(), workspaceTreeStatus: vi.fn() } }));
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
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({ roots });
  vi.mocked(projectApi.workspaceTreeStatus).mockResolvedValue({ revision: 1, indexing: false });
  vi.mocked(projectApi.listWorkspaceTree).mockImplementation(async (_, options) => page(options?.rootId, options?.path));
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
