import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceProjectSwitcher } from '../WorkspaceProjectSwitcher';
import { projectApi } from '../../../adapters/transport/project';
import { agentRuntimeApi } from '../../../adapters/transport/agentRuntime';
import { useSessionWorkspaceStore } from '../state/sessionWorkspaceStore';
import { useAgentSessionStore } from '../state/agentSessionStore';
import type { WorkspaceEnvironmentRepository } from '../workspaceEnvironmentView';

vi.mock('../../../adapters/transport/project', () => ({ projectApi: { listGitWorkspaces: vi.fn() } }));
vi.mock('../../../adapters/transport/agentRuntime', () => ({ agentRuntimeApi: { bindSessionWorktree: vi.fn() } }));
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
  useSessionWorkspaceStore.setState({ sessions: {} });
  useAgentSessionStore.setState({ sessions: [] });
  vi.mocked(projectApi.listGitWorkspaces).mockImplementation(async (_project, id) => ({
    repositoryRoot: `/repos/${id}`, defaultPath: `/repos/${id}`, branches: [], commits: [],
    worktrees: [{ path: `/repos/${id}`, branch: 'main', head: 'abc', primary: true, detached: false, locked: false, prunable: false, managed: false, dirty: false, sessionCount: 0 },
      ...(id === 'web' ? [{ path: '/trees/task', branch: 'feature/task', head: 'def', primary: false, detached: false, locked: false, prunable: false, managed: false, dirty: false, sessionCount: 0 }] : [])],
  }));
  vi.mocked(agentRuntimeApi.bindSessionWorktree).mockResolvedValue({ roots: [] });
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
