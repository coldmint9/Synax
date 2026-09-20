import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { RepositoryBranchPicker } from '../RepositoryBranchPicker';
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime';
vi.mock('../../../../lib/api/agentRuntime', () => ({ agentRuntimeApi: { listSessionBranches: vi.fn(), switchSessionBranch: vi.fn() } }));
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en' }) }));
const branches = { rootId: 'r', current: 'main', branches: [
  { name: 'main', current: true, occupied: false },
  { name: 'feature', current: false, occupied: false },
  { name: 'occupied', current: false, occupied: true },
] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(agentRuntimeApi.listSessionBranches).mockResolvedValue(branches); });
it('lists local branches and prevents choosing a branch used by another worktree', async () => {
  const changed = vi.fn();
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockResolvedValue({ ...branches, current: 'feature' });
  render(<RepositoryBranchPicker sessionId="s" rootId="r" branch="main" onSwitched={changed} />);
  await userEvent.click(screen.getByRole('button', { name: /Switch Git branch/ }));
  expect(await screen.findByRole('menuitem', { name: /occupied/ })).toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(screen.getByRole('menuitem', { name: 'feature' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(agentRuntimeApi.switchSessionBranch).toHaveBeenCalledWith('s', 'feature', 'r');
});
it('keeps a failed switch visible without duplicating its alert in a closing menu', async () => {
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockRejectedValue(new Error('uncommitted changes'));
  render(<RepositoryBranchPicker sessionId="s" rootId="r" branch="main" onSwitched={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /Switch Git branch/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'feature' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('uncommitted changes');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});
it('ignores a switch response after the repository component unmounts', async () => {
  let finish!: (value: typeof branches) => void;
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const changed = vi.fn();
  const view = render(<RepositoryBranchPicker sessionId="s" rootId="r" branch="main" onSwitched={changed} />);
  await userEvent.click(screen.getByRole('button', { name: /Switch Git branch/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'feature' }));
  view.unmount();
  await act(async () => finish(branches));
  expect(changed).not.toHaveBeenCalled();
});
