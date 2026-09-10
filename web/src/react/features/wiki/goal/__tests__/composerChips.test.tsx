import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GoalPermissionCycle } from '../GoalPermissionCycle'
import { GoalEffortPicker } from '../GoalEffortPicker'
import { REASONING_EFFORT_LABELS } from '../../../settings/lib/providerPresets'
import type { GoalPermissionTier } from '../goalAttachTypes'

afterEach(cleanup)

describe('GoalPermissionCycle', () => {
  it('exposes the active tier so each level can be colour-coded', () => {
    const { rerender } = render(
      <GoalPermissionCycle value="readonly" onChange={() => {}} />,
    )
    const button = screen.getByRole('button')
    expect(button.getAttribute('data-tier')).toBe('readonly')
    expect(button.textContent).toContain('只读')

    rerender(<GoalPermissionCycle value="readwrite" onChange={() => {}} />)
    expect(screen.getByRole('button').getAttribute('data-tier')).toBe('readwrite')

    rerender(<GoalPermissionCycle value="unrestricted" onChange={() => {}} />)
    expect(screen.getByRole('button').getAttribute('data-tier')).toBe('unrestricted')
  })

  it('cycles readonly -> readwrite -> unrestricted -> readonly', () => {
    const onChange = vi.fn()
    const order: GoalPermissionTier[] = ['readonly', 'readwrite', 'unrestricted']
    const expected: GoalPermissionTier[] = ['readwrite', 'unrestricted', 'readonly']

    order.forEach((tier, index) => {
      cleanup()
      onChange.mockReset()
      render(<GoalPermissionCycle value={tier} onChange={onChange} />)
      fireEvent.click(screen.getByRole('button'))
      expect(onChange).toHaveBeenCalledWith(expected[index])
    })
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
