import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useShellStore } from '../../../../state/shellStore'

vi.mock('../SettingsSelect', () => ({
  SettingsSelect: () => <div data-testid="settings-select" />,
}))

const { LayoutSection } = await import('../LayoutSection')

describe('LayoutSection', () => {
  beforeEach(() => {
    useShellStore.setState(state => ({
      preferences: {
        ...state.preferences,
        locale: 'en',
        sessionFoldWorkRuns: true,
      },
    }))
  })

  afterEach(() => cleanup())

  it('moves the work-log fold preference into settings', () => {
    render(<LayoutSection />)

    const toggle = screen.getByRole('switch', { name: 'Fold work log' })
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(true)

    fireEvent.click(toggle)
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(false)
  })
})
