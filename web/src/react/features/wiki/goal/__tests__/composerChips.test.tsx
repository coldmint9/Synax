import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GoalPermissionCycle } from '../GoalPermissionCycle'
import { GoalEffortPicker } from '../GoalEffortPicker'
import { REASONING_EFFORT_LABELS } from '../../../settings/lib/providerPresets'
import userEvent from '@testing-library/user-event'

afterEach(cleanup)

describe('GoalPermissionCycle', () => {
  it('does not present Synax tiers as if they controlled native CLI execution', () => {
    const change = vi.fn()
    render(<GoalPermissionCycle backendId="codex" value="boundary" onChange={change} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveAttribute('data-native-policy', 'true')
    expect(change).not.toHaveBeenCalled()
  })

  it('exposes only the three new approval modes with explicit selection', async () => {
    const onChange = vi.fn()
    const view = render(<GoalPermissionCycle value="boundary" onChange={onChange} />)
    const select = screen.getByRole('combobox')
    expect(select.closest('label')).toHaveAttribute('data-tier', 'boundary')
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['boundary', 'auto', 'unrestricted'])
    expect(select.closest('label')?.title).toContain('下一步生效')
    await userEvent.selectOptions(select, 'auto')
    expect(onChange).toHaveBeenCalledWith('auto')
    view.rerender(<GoalPermissionCycle value="auto" onChange={onChange} />)
    expect(screen.getByRole('combobox')).toHaveValue('auto')
  })

  it('does not claim a mode switch succeeded when the server rejects it', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('Permission update failed'))
    render(<GoalPermissionCycle value="boundary" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'unrestricted')
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission update failed')
    expect(screen.getByRole('combobox')).toHaveValue('boundary')
    expect(screen.getByRole('combobox')).toBeEnabled()
  })

})

describe('GoalEffortPicker', () => {
  it('shows the raw level id on the chip instead of a translated label', () => {
    render(<GoalEffortPicker effort="xhigh" onChange={() => {}} />)

    const trigger = screen.getByLabelText('思考强度')
    // raw id only — no Chinese tier name leaks into the chip
    expect(trigger.textContent).toBe('xhigh')
    for (const label of Object.values(REASONING_EFFORT_LABELS)) {
      expect(trigger.textContent).not.toContain(label)
    }
  })

  it('keeps the translated names for assistive tech', () => {
    render(<GoalEffortPicker effort="low" onChange={() => {}} />)
    expect(screen.getByLabelText('思考强度').textContent).toBe('low')
    // the aria-label on the control itself is unchanged
    expect(screen.getByLabelText('思考强度')).toBeTruthy()
  })
})
