import { useState, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachMenu } from '../ComposerAttachMenu';
import { useShellStore } from '../../../../shared/state/shellStore';
import { skillsApi, type SkillSummary } from '../../../../adapters/transport/skills';
import type { WikiDocument } from '../../../../shared/contracts/wiki';

vi.mock('../../../../shared/hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }));
const doc: WikiDocument = {
  id: 'doc-1', snapshotId: 'snapshot-a', projectId: 'project-a',
  title: 'Architecture', docType: 'landscape', parentId: null,
  contentMd: 'Generated content', references: [], pipelineStage: 'done',
  sortOrder: 0, manualState: 'none', staleState: 'fresh', isSection: false,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const skill: SkillSummary = {
  id: 'skill-1', name: 'review', label: 'Review code', description: 'Review changes',
  sourceId: 'local', sourceKind: 'local', version: '1', appliesTo: ['reviewer'],
  requiredCapabilities: [], permissionHints: [], status: 'available',
  installPath: '/fixture/review',
};
afterEach(() => { vi.restoreAllMocks(); useShellStore.setState(useShellStore.getInitialState()); });

describe('attachment form popover', () => {
  it('selects a wiki document and toggles skills without pretending the form is a menu', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences, wikiEnabled: true } }));
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ items: [skill], total: 1, hasMore: false });
    const selectDocument = vi.fn();
    function Example() {
      const [ids, setIds] = useState<string[]>([]);
      return <ComposerAttachMenu projectId="project-a" documentId={null} onDocumentChange={selectDocument} wikiAttachMode="manual" onWikiAttachModeChange={vi.fn()} documents={[doc]} skillIds={ids} onSkillIdsChange={setIds} />;
    }
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'agentAttach' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'agentAttachWiki' }));
    await user.click(screen.getByRole('radio', { name: 'Architecture' }));
    expect(selectDocument).toHaveBeenCalledWith('doc-1');
    const checkbox = await screen.findByRole('checkbox', { name: 'Review code' });
    await user.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await user.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(skillsApi.list).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('preserves unavailable wiki controls and native backend skills policy', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences, wikiEnabled: true } }));
    const load = vi.spyOn(skillsApi, 'list');
    const change = vi.fn();
    render(<ComposerAttachMenu projectId="project-a" documentId={null} onDocumentChange={change} wikiAttachMode="auto" onWikiAttachModeChange={change} documents={[doc]} skillIds={[]} onSkillIdsChange={change} wikiAttachDisabled skillsDisabled />);
    await user.click(screen.getByRole('button', { name: 'agentAttach' }));
    await user.click(screen.getByRole('button', { name: /agentAttachWiki/ }));
    const auto = screen.getByRole('switch', { name: 'agentWikiAuto' });
    expect(auto).toBeDisabled();
    await user.click(auto);
    expect(change).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText('This backend uses its native Skills configuration.')).toBeInTheDocument();
  });
});


function attachmentProps(): ComponentProps<typeof ComposerAttachMenu> {
  return {
    projectId: 'project-a', documentId: null, onDocumentChange: vi.fn(),
    wikiAttachMode: 'manual', onWikiAttachModeChange: vi.fn(), documents: [doc],
    skillIds: [], onSkillIdsChange: vi.fn(), onOverlayOpenChange: vi.fn(),
  };
}

describe('disabling attachment actions', () => {
  it('disables every open action and closes Headless UI itself, then reopens on the first click', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences, wikiEnabled: true } }));
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ items: [skill], total: 1, hasMore: false });
    const props = attachmentProps();
    const view = render(<ComposerAttachMenu {...props} />);
    const trigger = screen.getByRole('button', { name: 'agentAttach' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: /agentAttachWiki/ }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Review code' });
    const auto = screen.getByRole('switch', { name: 'agentWikiAuto' });
    const document = screen.getByRole('radio', { name: 'Architecture' });
    view.rerender(<ComposerAttachMenu {...props} disabled />);
    expect(trigger).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
    expect(auto).toBeDisabled();
    expect(document).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(props.onOverlayOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(checkbox);
    fireEvent.click(auto);
    fireEvent.click(document);
    expect(props.onSkillIdsChange).not.toHaveBeenCalled();
    expect(props.onWikiAttachModeChange).not.toHaveBeenCalled();
    expect(props.onDocumentChange).not.toHaveBeenCalled();
    view.rerender(<ComposerAttachMenu {...props} />);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('checkbox', { name: 'Review code' })).not.toHaveAttribute('aria-disabled');
    expect(props.onOverlayOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('keeps skills usable when only Wiki becomes disabled in an open popover', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences, wikiEnabled: true } }));
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ items: [skill], total: 1, hasMore: false });
    const props = attachmentProps();
    const view = render(<ComposerAttachMenu {...props} />);
    await user.click(screen.getByRole('button', { name: 'agentAttach' }));
    await user.click(screen.getByRole('button', { name: /agentAttachWiki/ }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Review code' });
    view.rerender(<ComposerAttachMenu {...props} wikiAttachDisabled />);
    expect(screen.getByRole('button', { name: 'agentAttach' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('switch')).toBeDisabled();
    const radio = screen.getByRole('radio', { name: 'Architecture' });
    expect(radio).toHaveAttribute('aria-disabled', 'true');
    await user.click(radio);
    await user.click(screen.getByRole('switch'));
    await user.click(checkbox);
    expect(props.onDocumentChange).not.toHaveBeenCalled();
    expect(props.onWikiAttachModeChange).not.toHaveBeenCalled();
    expect(props.onSkillIdsChange).toHaveBeenCalledWith(['skill-1']);
  });

  it('keeps Wiki usable when only skills become disabled in an open popover', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences, wikiEnabled: true } }));
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ items: [skill], total: 1, hasMore: false });
    const props = attachmentProps();
    const view = render(<ComposerAttachMenu {...props} />);
    await user.click(screen.getByRole('button', { name: 'agentAttach' }));
    await screen.findByRole('checkbox', { name: 'Review code' });
    view.rerender(<ComposerAttachMenu {...props} skillsDisabled />);
    expect(screen.getByRole('button', { name: 'agentAttach' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('This backend uses its native Skills configuration.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /agentAttachWiki/ }));
    await user.click(screen.getByRole('radio', { name: 'Architecture' }));
    await user.click(screen.getByRole('switch'));
    expect(props.onDocumentChange).toHaveBeenCalledWith('doc-1');
    expect(props.onWikiAttachModeChange).toHaveBeenCalledWith('auto');
    expect(props.onSkillIdsChange).not.toHaveBeenCalled();
  });
});
