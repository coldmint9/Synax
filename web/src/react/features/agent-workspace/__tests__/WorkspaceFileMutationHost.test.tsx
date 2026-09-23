import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime';
import { WorkspaceFileMutationHost } from '../WorkspaceFileMutationHost';
import { requestFileMutation } from '../fileContextMutations';
import { useSessionWorkspaceStore } from '../state/sessionWorkspaceStore';
import { useAgentSessionStore } from '../state/agentSessionStore';

function start() { render(<MemoryRouter><WorkspaceFileMutationHost /></MemoryRouter>); }
const tabs = [{ id: 'file@api:src/a.ts', kind: 'file' as const, title: 'API / a.ts', path: 'src/a.ts', rootId: 'api' }];

beforeEach(() => {
  useAgentSessionStore.setState({ sessions: [{ id: 'session-1', status: 'completed' }] as ReturnType<typeof useAgentSessionStore.getState>['sessions'] });
  useSessionWorkspaceStore.setState({ sessions: { 'session-1': { tabs, activeTabId: tabs[0].id, presentation: 'dock' } } });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('workspace file mutation confirmation', () => {
  it('renames a file and retargets its open tab only after API success', async () => {
    const rename = vi.spyOn(agentRuntimeApi, 'renameSessionEnvironmentFile').mockResolvedValue({
      sessionId: 'session-1', previousPath: 'src/a.ts', path: 'src/new.ts',
    });
    start();
    act(() => requestFileMutation({ sessionId: 'session-1', rootId: 'api', path: 'src/a.ts', kind: 'rename' }));
    const name = await screen.findByLabelText('新文件名');
    fireEvent.change(name, { target: { value: 'new.ts' } });
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs[0].path).toBe('src/a.ts');
    fireEvent.click(screen.getByRole('button', { name: '重命名文件' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('session-1', { path: 'src/a.ts', newName: 'new.ts', rootId: 'api' }));
    await waitFor(() => expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs[0].path).toBe('src/new.ts'));
  });
  it('requires confirmation before trash and preserves tabs when cancelled', async () => {
    const trash = vi.spyOn(agentRuntimeApi, 'trashSessionEnvironmentFile').mockResolvedValue({ sessionId: 'session-1', path: 'src/a.ts', trashed: true });
    start();
    act(() => requestFileMutation({ sessionId: 'session-1', rootId: 'api', path: 'src/a.ts', kind: 'trash' }));
    expect(await screen.findByText(/移到系统废纸篓/)).toBeTruthy();
    expect(trash).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs).toHaveLength(1);
    act(() => requestFileMutation({ sessionId: 'session-1', rootId: 'api', path: 'src/a.ts', kind: 'trash' }));
    fireEvent.click(await screen.findByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(trash).toHaveBeenCalledWith('session-1', { path: 'src/a.ts', rootId: 'api' }));
    await waitFor(() => expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs).toHaveLength(0));
  });
});
