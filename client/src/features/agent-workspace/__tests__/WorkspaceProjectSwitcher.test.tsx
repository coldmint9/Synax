import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { WorkspaceProjectSwitcher } from '../WorkspaceProjectSwitcher';
import { projectApi } from '../../../adapters/transport/project';
import { agentRuntimeApi } from '../../../adapters/transport/agentRuntime';
import { useSessionWorkspaceStore } from '../state/sessionWorkspaceStore';
import { useAgentSessionStore } from '../state/agentSessionStore';
import type { AgentSession } from '../../../adapters/transport/agentRuntime';
import type { WorkspaceEnvironmentRepository } from '../workspaceEnvironmentView';
import { invalidateStaleResource } from '../../../shared/lib/staleResource';

vi.mock('../../../adapters/transport/project', () => ({ projectApi: { listGitWorkspaces: vi.fn(), removeGitWorktree: vi.fn() } }));
vi.mock('../../../adapters/transport/agentRuntime', () => ({ agentRuntimeApi: { bindSessionWorktree: vi.fn(), listSessionBranches: vi.fn(), switchSessionBranch: vi.fn(), createSessionBranch: vi.fn() } }));
const reload = vi.fn();
const root = (id: string): WorkspaceEnvironmentRepository => ({ rootId: id, name: id, role: id === 'api' ? 'primary' : 'reference', status: 'ready', workspacePath: `/repos/${id}`, branch: 'main', headCommitSha: 'abc', dirty: false, additions: 0, deletions: 0, changedFiles: [], agentChangedFiles: [], inputSources: [], outputFiles: [] });
let sequence = 0;
function Fixture() {
  const [selected, setSelected] = useState('api');
  return <WorkspaceProjectSwitcher sessionId="session" projectId={`fixture-${sequence}`} repositories={[root('api'), root('web')]} selectedRootId={selected} onSelect={setSelected} reload={reload} />;
}
beforeEach(() => {
  sequence++;
  vi.clearAllMocks();
  invalidateStaleResource('session-git-branches:session:api');
  invalidateStaleResource('session-git-branches:session:web');
  useSessionWorkspaceStore.setState({ sessions: {} });
  useAgentSessionStore.setState({ sessions: [] });
  vi.mocked(projectApi.listGitWorkspaces).mockImplementation(async (_project, id) => ({
    repositoryRoot: `/repos/${id}`, defaultPath: `/repos/${id}`, branches: [], commits: [],
    worktrees: [{ path: `/repos/${id}`, branch: 'main', head: 'abc', primary: true, detached: false, locked: false, prunable: false, managed: false, dirty: false, sessionCount: 0 },
      ...(id === 'web' ? [{ path: '/trees/task', branch: 'feature/task', head: 'def', primary: false, detached: false, locked: false, prunable: false, managed: false, dirty: false, sessionCount: 0 }] : [])],
  }));
  vi.mocked(agentRuntimeApi.bindSessionWorktree).mockResolvedValue({ roots: [] });
  vi.mocked(agentRuntimeApi.listSessionBranches).mockImplementation(async (_session, rootId) => ({
    rootId: rootId!, current: 'main', dirtyFileCount: 0,
    branches: [{ name: 'main', current: true, occupied: false }, { name: 'feature/available', current: false, occupied: false }],
  }));
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockResolvedValue({ rootId: 'web', current: 'feature/available', branches: [], dirtyFileCount: 0 });
});

it('toggles worktrees on repeated project clicks while keeping the active project, counts and branch trigger', async () => {
  render(<Fixture />);
  const web = screen.getByRole('button', { name: 'web · main' });
  fireEvent.click(web);
  await screen.findByRole('button', { name: 'web · task · feature/task' });
  fireEvent.click(web);
  expect(web).toHaveAttribute('aria-pressed', 'true');
  expect(web).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'web · task · feature/task' })).toBeNull();
  expect(screen.getByRole('button', { name: '切换 Git 分支: main' })).toBeEnabled();
  fireEvent.click(web);
  expect(web).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'web · task · feature/task' })).toBeVisible();
  fireEvent.click(web);
  fireEvent.click(screen.getByRole('button', { name: 'api · main' }));
  fireEvent.click(web);
  expect(web).toHaveAttribute('aria-expanded', 'true');
  expect(agentRuntimeApi.bindSessionWorktree).not.toHaveBeenCalled();
});

it('switches the active project main-directory branch through its scoped picker without folding its worktrees', async () => {
  render(<Fixture />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'web · main' }));
  await screen.findByRole('button', { name: 'web · 主目录 · main' });
  await user.click(screen.getByRole('button', { name: '切换 Git 分支: main' }));
  await user.click(await screen.findByRole('option', { name: 'feature/available', exact: true }));
  await waitFor(() => expect(agentRuntimeApi.switchSessionBranch).toHaveBeenCalledWith('session', 'feature/available', 'web'));
  expect(agentRuntimeApi.listSessionBranches).toHaveBeenCalledWith('session', 'web');
  await waitFor(() => expect(reload).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'web · main' })).toHaveAttribute('aria-expanded', 'true');
  expect(agentRuntimeApi.bindSessionWorktree).not.toHaveBeenCalled();
});

it('offers branch switching on ordinary projects without creating a worktree dropdown', async () => {
  render(<Fixture />);
  await userEvent.click(screen.getByRole('button', { name: '切换 Git 分支: main' }));
  await screen.findByRole('option', { name: 'feature/available', exact: true });
  expect(agentRuntimeApi.listSessionBranches).toHaveBeenCalledWith('session', 'api');
  expect(screen.getByRole('button', { name: 'api · main' })).not.toHaveAttribute('aria-expanded');
});

it('does not request a binding change when the selected main directory is clicked again', async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  fireEvent.click(await screen.findByRole('button', { name: 'web · 主目录 · main' }));
  expect(agentRuntimeApi.bindSessionWorktree).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'web · main' })).toHaveAttribute('aria-expanded', 'true');
});

it('keeps ordinary projects active without a dropdown or fold arrow and only opens the active worktree project', async () => {
  const { container } = render(<Fixture />);
  const api = screen.getByRole('button', { name: 'api · main' });
  expect(api).toHaveAttribute('aria-pressed', 'true');
  expect(api).not.toHaveAttribute('aria-expanded');
  fireEvent.click(api); expect(api).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  await screen.findByRole('button', { name: 'web · task · feature/task' });
  expect(screen.getByRole('button', { name: 'web · main' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(api);
  expect(screen.queryByRole('button', { name: 'web · task · feature/task' })).toBeNull();
  expect(container.querySelector('.lucide-chevron-down, .lucide-chevron-right')).toBeNull();
  expect(agentRuntimeApi.bindSessionWorktree).not.toHaveBeenCalled();
});
it('replaces worktree totals with two independent file counts, including projects with no worktrees', async () => {
  const api = { ...root('api'), changedFiles: [
    { path: 'staged.ts', status: 'added' as const, staged: true, untracked: false, additions: 10, deletions: 0 },
    { path: 'modified.ts', status: 'modified' as const, staged: false, untracked: false, additions: 2, deletions: 1 },
    { path: 'new.ts', status: 'untracked' as const, staged: false, untracked: true, additions: 20, deletions: 0 },
  ] };
  const view = render(<WorkspaceProjectSwitcher sessionId="session" projectId={`fixture-${sequence}`} repositories={[api, root('web')]}
    selectedRootId="api" onSelect={vi.fn()} reload={reload} />);
  const project = screen.getByRole('button', { name: 'api · main' });
  expect(within(project).getByTitle('未提交 2 个文件')).toHaveTextContent('2');
  expect(within(project).getByTitle('未跟踪 1 个文件')).toHaveTextContent('1');
  await waitFor(() => expect(projectApi.listGitWorkspaces).toHaveBeenCalled());
  expect(view.container.querySelector('.shadow-project-count')).toBeNull();
  expect(screen.getByRole('button', { name: 'web · main' }).querySelector('.workspace-git-count-badges')).toBeNull();
});
it('uses the session root and current path when binding a worktree', async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  fireEvent.click(await screen.findByRole('button', { name: 'web · task · feature/task' }));
  await waitFor(() => expect(agentRuntimeApi.bindSessionWorktree).toHaveBeenCalledWith('session', { rootId: 'web', path: '/trees/task', expectedPath: '/repos/web' }));
  await waitFor(() => expect(reload).toHaveBeenCalled());
});
it('keeps the current selection and displays a failed binding without pretending it switched', async () => {
  vi.mocked(agentRuntimeApi.bindSessionWorktree).mockRejectedValueOnce(new Error('工作树正在被使用'));
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  fireEvent.click(await screen.findByRole('button', { name: 'web · task · feature/task' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('工作树正在被使用');
  expect(screen.getByRole('button', { name: 'web · 主目录 · main' })).toHaveAttribute('aria-pressed', 'true');
  expect(reload).not.toHaveBeenCalled();
});

it('shows the robot on the running checkout while retaining the user checkmark', async () => {
  useAgentSessionStore.setState({ sessions: [{ id: 'session', status: 'running', activeRunId: 'run', sessionMetadata: { backend: {
    executionRootId: 'web', userWorktrees: { web: { path: '/repos/web' } }, rootWorktrees: { web: { path: '/trees/task' } },
  } } } as unknown as AgentSession] });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  const tree = await screen.findByRole('button', { name: 'web · task · feature/task' });
  expect(within(tree).getByRole('img', { name: 'Agent 正在此目录运行' })).toBeInTheDocument();
  expect(tree).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'web · 主目录 · main' })).toHaveAttribute('aria-pressed', 'true');
  act(() => useAgentSessionStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, status: 'completed', activeRunId: null })) })));
  expect(screen.queryByRole('img', { name: 'Agent 正在此目录运行' })).toBeNull();
});

it('deletes a missing row in one click without a dialog or Git-status preflight', async () => {
  const original = vi.mocked(projectApi.listGitWorkspaces).getMockImplementation()!;
  let removed = false;
  vi.mocked(projectApi.listGitWorkspaces).mockImplementation(async (...args) => {
    const summary = await original(...args);
    return { ...summary, worktrees: summary.worktrees.filter(tree => tree.primary || !removed).map(tree => tree.primary ? tree : { ...tree, prunable: true, statusKnown: false }) };
  });
  vi.mocked(projectApi.removeGitWorktree).mockImplementation(async () => { removed = true; return { removed: true }; });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'web · main' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除工作树 task' }));
  await waitFor(() => expect(projectApi.removeGitWorktree).toHaveBeenCalledWith(`fixture-${sequence}`, { path: '/trees/task', rootId: 'web', missingOnly: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith(expect.any(String), 'web', 'inventory');
  expect(vi.mocked(projectApi.listGitWorkspaces).mock.calls.every(call => call[2] === 'inventory')).toBe(true);
  await waitFor(() => expect(screen.queryByText('目录缺失')).toBeNull());
});
