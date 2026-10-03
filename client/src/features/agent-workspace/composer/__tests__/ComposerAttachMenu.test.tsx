import { useState, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachMenu } from '../ComposerAttachMenu';
import { useShellStore } from '../../../../shared/state/shellStore';
import { skillsApi, type SkillSummary } from '../../../../adapters/transport/skills';

vi.mock('../../../../shared/hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }));
const skill: SkillSummary = {
  id: 'skill-1', name: 'review', label: 'Review code', description: 'Review changes',
  sourceId: 'local', sourceKind: 'local', version: '1', appliesTo: ['reviewer'],
  requiredCapabilities: [], permissionHints: [], status: 'available',
  installPath: '/fixture/review',
};
afterEach(() => { vi.restoreAllMocks(); useShellStore.setState(useShellStore.getInitialState()); });

describe('attachment form popover', () => {
});


function attachmentProps(): ComponentProps<typeof ComposerAttachMenu> {
  return {
    projectId: 'project-a',

    skillIds: [], onSkillIdsChange: vi.fn(), onOverlayOpenChange: vi.fn(),
  };
}

describe('disabling attachment actions', () => {
  it('disables every open action and closes Headless UI itself, then reopens on the first click', async () => {
    const user = userEvent.setup();
    useShellStore.setState(state => ({ preferences: { ...state.preferences } }));
    vi.spyOn(skillsApi, 'list').mockResolvedValue({ items: [skill], total: 1, hasMore: false });
    const props = attachmentProps();
    const view = render(<ComposerAttachMenu {...props} />);
    const trigger = screen.getByRole('button', { name: 'agentAttach' });
    await user.click(trigger);
    const checkbox = await screen.findByRole('checkbox', { name: 'Review code' });
    view.rerender(<ComposerAttachMenu {...props} disabled />);
    expect(trigger).toBeDisabled();
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(props.onOverlayOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(checkbox);
    expect(props.onSkillIdsChange).not.toHaveBeenCalled();
    view.rerender(<ComposerAttachMenu {...props} />);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('checkbox', { name: 'Review code' })).not.toHaveAttribute('aria-disabled');
    expect(props.onOverlayOpenChange).toHaveBeenLastCalledWith(true);
  });
});
