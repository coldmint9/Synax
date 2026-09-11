import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SessionModePicker } from '../SessionModePicker'
import { GoalComposerPill } from '../../wiki/goal/GoalComposerPill'

vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }))
vi.mock('../../wiki/goal/GoalAttachMenu', () => ({ GoalAttachMenu: () => <button>Attach</button> }))
vi.mock('../../wiki/goal/GoalPermissionCycle', () => ({ GoalPermissionCycle: () => <button>Permission</button> }))
vi.mock('../../wiki/goal/GoalModelPicker', () => ({ GoalModelPicker: () => <button>Model</button> }))
vi.mock('../../wiki/goal/GoalEffortPicker', () => ({ GoalEffortPicker: () => <button>Effort</button> }))

const props = {
  projectId: 'p1', content: '', onContentChange: vi.fn(), onSubmit: vi.fn(),
  providerId: null, modelId: null, onModelSelect: vi.fn(), providers: [], globalConfig: null,
  documentId: null, onDocumentChange: vi.fn(), wikiAttachMode: 'auto' as const, onWikiAttachModeChange: vi.fn(),
  documents: [], skillIds: [], onSkillIdsChange: vi.fn(), reasoningEffort: 'high' as const,
  onReasoningEffortChange: vi.fn(), permissionTier: 'readonly' as const, onPermissionTierChange: vi.fn(),
}

describe('compact session mode control', () => {
  it.each([false, true])('keeps the optional control inside the shared composer (expanded=%s)', expanded => {
    const { container } = render(<GoalComposerPill {...props} defaultExpanded={expanded} modeControl={<SessionModePicker mode="chat" disabled={false} description="Mode does not change permissions." onChange={vi.fn()} />} />)
    const control = screen.getByRole('button', { name: 'Session mode' })
    expect(control.closest('.goal-dock-composer')).toBeTruthy()
    expect(control.compareDocumentPosition(screen.getByRole('button', { name: 'Model' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('.agent-mode-trigger')).toHaveLength(1)
  })

  it('does not add session controls to other shared composer consumers', () => {
    render(<GoalComposerPill {...props} />)
    expect(screen.queryByRole('button', { name: 'Session mode' })).not.toBeInTheDocument()
  })

  it('supports keyboard selection and returns focus to the trigger', async () => {
    const onChange = vi.fn(), user = userEvent.setup()
    render(<SessionModePicker mode="chat" disabled={false} description="Mode does not change permissions." onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Session mode' })
    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('listbox', { name: 'Session mode' })).toBeVisible()
    // In a layout-less DOM the popover focuses its dialog first; Tab enters the list.
    await user.tab()
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chat' })).toHaveFocus())
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Plan' })).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('plan')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('cannot open the picker when the existing safety guard disables switching', async () => {
    const onChange = vi.fn()
    render(<SessionModePicker mode="goal" disabled description="Resolve the pending request first." onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Session mode' })
    expect(trigger).toBeDisabled()
    await userEvent.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
