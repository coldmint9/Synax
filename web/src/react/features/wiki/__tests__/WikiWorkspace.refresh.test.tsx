import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWikiStore } from '../../../state/wikiStore';
import WikiWorkspace from '../WikiWorkspace';

const renderDock = vi.hoisted(() => vi.fn());
vi.mock('../../../../hooks/useWikiGenerationEvents', () => ({ useWikiGenerationEvents: () => ({ active: false, phase: 'idle', progress: null }) }));
vi.mock('../../../../hooks/useWikiRefreshListener', () => ({ useWikiRefreshListener: () => {} }));
vi.mock('../../../../hooks/useScrollRestore', () => ({ useScrollRestore: () => ({ current: null }) }));
vi.mock('../WikiDocumentTree', () => ({ default: () => <div>Document tree</div> }));
vi.mock('../WikiDocumentView', () => ({ default: () => <article>Cached document</article> }));
vi.mock('../PlanView', () => ({ default: () => <div>Plan</div> }));
vi.mock('../PlanListView', () => ({ default: () => <div>Plans</div> }));
vi.mock('../../agent-workspace/dock/AgentDock', () => ({ AgentDock: () => { renderDock(); return <input aria-label="Wiki draft" defaultValue="" />; } }));
const original = useWikiStore.getState();
beforeEach(() => {
  renderDock.mockClear();
  useWikiStore.setState({
    snapshot: { id: 's', projectId: 'p', branch: 'main', headCommitSha: 'abc', workingTreeHash: '', repoIndexId: null, revision: 1, status: 'ready', documentIds: ['d'], createdAt: '', createdBy: 'system' },
    documents: [{ id: 'd', snapshotId: 's', projectId: 'p', title: 'Document', docType: 'module', parentId: null, contentMd: 'Content', references: [], pipelineStage: 'done', sortOrder: 0, manualState: 'none', staleState: 'fresh', isSection: false, createdAt: '', updatedAt: '' }],
    selectedDocumentId: 'd', viewMode: 'document', loading: { snapshot: false, plans: false, drafts: false },
    loadGoals: vi.fn(async () => {}), draftPanelOpen: false,
  });
});
afterEach(() => { cleanup(); useWikiStore.setState(original, true); });

describe('Wiki background refresh', () => {
  it('keeps the document and input mounted while refreshing the same project', () => {
    render(<WikiWorkspace projectId="p" />);
    const article = screen.getByText('Cached document');
    const draft = screen.getByRole('textbox', { name: 'Wiki draft' });
    fireEvent.change(draft, { target: { value: 'Unsent draft' } });
    act(() => useWikiStore.setState({ loading: { snapshot: true, plans: false, drafts: false } }));
    expect(screen.getByText('Cached document')).toBe(article);
    expect(screen.getByRole('textbox', { name: 'Wiki draft' })).toBe(draft);
    act(() => useWikiStore.setState({ loading: { snapshot: false, plans: false, drafts: false } }));
    expect(screen.getByRole('textbox', { name: 'Wiki draft' })).toHaveValue('Unsent draft');
  });
  it('does not rebuild the unchanged composer when switching document and plan', () => {
    render(<WikiWorkspace projectId="p" />);
    act(() => useWikiStore.setState({ viewMode: 'plan' }));
    act(() => useWikiStore.setState({ viewMode: 'document' }));
    expect(renderDock).toHaveBeenCalledTimes(1);
  });
  it('still hides stale content when loading a different project', () => {
    useWikiStore.setState({ loading: { snapshot: true, plans: false, drafts: false } });
    render(<WikiWorkspace projectId="different-project" />);
    expect(screen.queryByText('Cached document')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Wiki draft' })).toBeNull();
  });
  it('still shows the initial loading view when no snapshot exists', () => {
    useWikiStore.setState({ snapshot: null, loading: { snapshot: true, plans: false, drafts: false } });
    render(<WikiWorkspace projectId="p" />);
    expect(screen.queryByText('Cached document')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Wiki draft' })).toBeNull();
  });
});
