import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseGlobalSettings } from './ComputerUseGlobalSettings'

afterEach(() => { Reflect.deleteProperty(window, 'electronAPI') })

describe('Computer Use global settings', () => {
  it('defaults to Direct Cua with perception disabled and Jev off', () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(<ComputerUseGlobalSettings locale="en" onUpdate={onUpdate} />)
    expect(screen.getByRole('combobox', { name: 'Computer Use strategy' })).toHaveValue('auto')
    expect(screen.getByRole('combobox', { name: 'Visual perception' })).toHaveValue('disabled')
    expect(screen.getByRole('checkbox', { name: /Enable Jev/ })).not.toBeChecked()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('saves perception and Jev changes through the global config patch', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ComputerUseGlobalSettings locale="en" onUpdate={onUpdate} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Visual perception' }), 'required')
    expect(onUpdate).toHaveBeenCalledWith({
      computerUse: { enabled: true, strategy: 'auto', perception: 'required' },
    })
    await user.click(screen.getByRole('checkbox', { name: /Enable Jev/ }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      computerUse: expect.objectContaining({
        jev: expect.objectContaining({ enabled: true, fallback: 'fail_closed' }),
      }),
    })
  })

  it('writes the Jev key without echoing the stored plaintext', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const { container } = render(
      <ComputerUseGlobalSettings
        locale="en"
        value={{
          enabled: true,
          strategy: 'jev',
          perception: 'disabled',
          jev: { enabled: true, fallback: 'fail_closed', apiKeyMasked: '****' },
        }}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.getByText(/Stored: \*\*\*\*/)).toBeInTheDocument()
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    await user.type(input, 'sk-new-secret')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).toHaveBeenCalledWith({
      computerUse: expect.objectContaining({
        jev: expect.objectContaining({ apiKey: 'sk-new-secret', apiKeyMasked: '****' }),
      }),
    })
  })
})
