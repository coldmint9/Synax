import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { TerminalDrawer } from '../TerminalDrawer';
import { useTerminalStore } from '../terminalStore';
import { terminalApi, type TerminalSession } from '../../../../lib/api/terminal';
const mocks = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('../TerminalViewport', async () => {
  const { useEffect } = await import('react');
  return { TerminalViewport: ({ session, visible }: any) => { useEffect(() => { mocks.mounted(session.id); return () => mocks.unmounted(session.id); }, [session.id]); return <div hidden={!visible}>terminal:{session.id}</div>; } };
});
vi.mock('../../../../lib/api/project', () => ({ projectApi: { getWorkspace: vi.fn().mockResolvedValue({ roots: [{ id: 'p', name: 'Project', path: '/project', status: 'available', role: 'primary' }] }) } }));
vi.mock('../../../../lib/api/terminal', () => ({ terminalApi: { create: vi.fn(), stop: vi.fn(), remove: vi.fn(), restartLegacy: vi.fn() } }));
const item = (id: string): TerminalSession => ({ id, projectId: 'p', rootId: 'p', ownerSessionId: null, kind: 'terminal', title: 'Project', cwd: '/project', shell: '/bin/sh', command: null, pid: 42, state: 'active', exitCode: null, startedAt: '', endedAt: null, cols: 80, rows: 24 });
beforeEach(() => { vi.clearAllMocks(); useTerminalStore.setState({ open: true, tabs: [], activeId: null, pending: 0, error: null }); });
it('keeps terminal views mounted across tab switches and drawer hiding', async () => {
  useTerminalStore.getState().accept(item('one')); useTerminalStore.getState().accept(item('two'));
  render(<TerminalDrawer projectId="p" sessionId={null} />);
  await userEvent.click(screen.getByRole('tab', { name: /终端 1/ }));
  await userEvent.click(screen.getByRole('button', { name: '收起终端' }));
  expect(mocks.mounted).toHaveBeenCalledTimes(2); expect(mocks.unmounted).not.toHaveBeenCalled();
  expect(terminalApi.stop).not.toHaveBeenCalled();
  act(() => useTerminalStore.getState().show());
  expect(screen.getByText('terminal:one')).toBeVisible();
});
it('keeps legacy services untouched until the explicit restart confirmation is submitted', async () => {
  useTerminalStore.getState().openLegacy({ sessionId: 's', projectId: 'p', cwd: '/project', process: { id: 'old', command: 'npm run dev', pid: 77, state: 'active', exitCode: null, startedAt: '', endedAt: null } });
  vi.mocked(terminalApi.restartLegacy).mockResolvedValue(item('new'));
  render(<TerminalDrawer projectId="p" sessionId={null} />);
  expect(screen.getByText('此服务尚未接入交互终端')).toBeVisible();
  expect(terminalApi.restartLegacy).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '确认停止旧服务并重启到终端' }));
  await waitFor(() => expect(terminalApi.restartLegacy).toHaveBeenCalledWith('s', 'old', expect.objectContaining({ command: 'npm run dev', cwd: '/project' })));
  expect(useTerminalStore.getState().activeId).toBe('new'); expect(terminalApi.stop).not.toHaveBeenCalled();
});
it('disables deleting a live terminal and enables it after the terminal exits', async () => {
  useTerminalStore.getState().accept(item('one'));
  render(<TerminalDrawer projectId="p" sessionId={null} />);
  expect(screen.getByRole('button', { name: '删除终端记录' })).toBeDisabled();
  act(() => useTerminalStore.getState().update({ ...item('one'), state: 'closed' }));
  expect(screen.getByRole('button', { name: '删除终端记录' })).toBeEnabled();
});
