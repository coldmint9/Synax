import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseSettings } from './ComputerUseSettings'

afterEach(() => { Reflect.deleteProperty(window, 'electronAPI') })

describe('Computer Use settings', () => {
  it('defaults to Direct Cua without a Jev credential or client call', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const getComputerUseStatus = vi.fn().mockResolvedValue({ state: 'ready', error: null })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUseStatus } })
    render(<ComputerUseSettings locale="en" onSave={onSave} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ready'))
    expect(screen.getByRole('combobox', { name: 'Computer Use strategy' })).toHaveValue('auto')
    expect(screen.getByRole('checkbox', { name: /Enable Jev/ })).not.toBeChecked()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('explicitly enables Jev with fail-closed as the safe default', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ComputerUseSettings locale="en" onSave={onSave} />)
    await userEvent.setup().click(screen.getByRole('checkbox', { name: /Enable Jev/ }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ strategy: 'auto', jev: { enabled: true, fallback: 'fail_closed' } }))
  })
})
