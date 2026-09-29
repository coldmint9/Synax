import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { McpServersSection } from './McpServersSection'
const status = vi.hoisted(() => ({ value: { state: 'unavailable', error: 'Helper missing' } as { state: string; error: string | null } | null }))
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }))
vi.mock('../useComputerUseStatus', () => ({ useComputerUseStatus: () => status.value }))

describe('built-in MCP settings', () => {
  it('shows the built-in driver even when unavailable and preserves advanced settings while toggling', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const initial = { enabled: true, strategy: 'jev' as const, perception: 'auto' as const, jev: { enabled: true, fallback: 'fail_closed' as const } }
    function Harness() {
      const [value, setValue] = useState(initial)
      return <McpServersSection servers={[]} builtinComputerUse={value} onSaveBuiltinComputerUse={async next => { await save(next); setValue(next as typeof initial) }} />
    }
    render(<Harness />)
    expect(screen.getByText('Cua Driver')).toBeInTheDocument()
    expect(screen.getByText('Built-in')).toBeInTheDocument()
    expect(screen.getByText('Helper missing')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Enable Cua Driver' })
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(save).toHaveBeenLastCalledWith({ ...initial, enabled: false })
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(save).toHaveBeenLastCalledWith(initial)
  })
  it('keeps the persisted state and reports a failed save', async () => {
    render(<McpServersSection servers={[]} builtinComputerUse={{ enabled: true, strategy: 'auto' }} onSaveBuiltinComputerUse={vi.fn().mockRejectedValue(new Error('Offline'))} />)
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })
  it('keeps the control visible outside Electron', () => {
    status.value = null
    render(<McpServersSection servers={[]} onSaveBuiltinComputerUse={vi.fn()} />)
    expect(screen.getByRole('switch')).toBeEnabled()
    expect(screen.getByText(/desktop app required/)).toBeInTheDocument()
  })
})
