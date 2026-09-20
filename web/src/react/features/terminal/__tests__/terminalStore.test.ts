import { beforeEach, expect, it, vi } from 'vitest';
import { terminalApi, type TerminalSession } from '../../../../lib/api/terminal';
import { useTerminalStore } from '../terminalStore';
vi.mock('../../../../lib/api/terminal', () => ({ terminalApi: { get: vi.fn(), create: vi.fn(), stop: vi.fn(), remove: vi.fn() } }));
const item = (id: string): TerminalSession => ({ id, projectId: 'p', rootId: 'r', ownerSessionId: null, kind: 'terminal', title: 'Project', cwd: '/project', shell: '/bin/sh', command: null, pid: 42, state: 'active', exitCode: null, startedAt: '', endedAt: null, cols: 80, rows: 24 });
beforeEach(() => { vi.resetAllMocks(); useTerminalStore.setState({ open: false, tabs: [], activeId: null, pending: 0, error: null }); });
it('hides and closes views without stopping or deleting their terminal processes', () => {
  useTerminalStore.getState().accept(item('one'));
  useTerminalStore.getState().hide();
  expect(useTerminalStore.getState().tabs).toHaveLength(1);
  useTerminalStore.getState().show();
  expect(useTerminalStore.getState().activeId).toBe('one');
  useTerminalStore.getState().closeTab('one');
  expect(terminalApi.stop).not.toHaveBeenCalled(); expect(terminalApi.remove).not.toHaveBeenCalled();
});
it('reopens the same terminal without duplicating its tab', async () => {
  vi.mocked(terminalApi.get).mockResolvedValue(item('one'));
  await useTerminalStore.getState().openTerminal('p', 'one');
  await useTerminalStore.getState().openTerminal('p', 'one');
  expect(useTerminalStore.getState().tabs).toHaveLength(1);
  expect(terminalApi.get).toHaveBeenCalledTimes(1);
});
it('keeps the last chosen terminal active when earlier requests finish late', async () => {
  let finish!: (item: TerminalSession) => void;
  vi.mocked(terminalApi.get).mockImplementation((_project, id) => id === 'one' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(item(id)));
  const first = useTerminalStore.getState().openTerminal('p', 'one');
  await useTerminalStore.getState().openTerminal('p', 'two');
  finish(item('one')); await first;
  expect(useTerminalStore.getState().activeId).toBe('two'); expect(useTerminalStore.getState().pending).toBe(0);
});
it('passes the explicit worktree selection when creating a new terminal', async () => {
  vi.mocked(terminalApi.create).mockResolvedValue(item('new'));
  await useTerminalStore.getState().create('p', 'reference-root', 'session-one');
  expect(terminalApi.create).toHaveBeenCalledWith('p', expect.objectContaining({ rootId: 'reference-root', sessionId: 'session-one', requestId: expect.any(String) }));
  expect(useTerminalStore.getState().activeId).toBe('new');
});
