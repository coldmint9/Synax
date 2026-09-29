import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseGlobalSettings } from './ComputerUseGlobalSettings'
import type { ProviderDef } from '../../../../lib/contracts/config'

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

  it('offers the configured providers for Jev and saves the selection', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const onConfigureProvider = vi.fn()
    const user = userEvent.setup()
    const providers: ProviderDef[] = [
      { id: 'openai', label: 'OpenAI', status: 'live', kind: 'api', caps: { canFollowUp: true, canCancel: true }, models: [] },
      { id: 'custom-api:openrouter', label: 'OpenRouter', status: 'live', kind: 'api', caps: { canFollowUp: true, canCancel: true }, models: [] },
    ]
    render(
      <ComputerUseGlobalSettings
        locale="en"
        value={{ enabled: true, strategy: 'jev', perception: 'disabled', jev: { enabled: true, fallback: 'fail_closed' } }}
        providers={providers}
        onConfigureProvider={onConfigureProvider}
        onUpdate={onUpdate}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Jev provider' })
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'OpenRouter' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Configure OpenRouter' })).not.toBeInTheDocument()
    await user.selectOptions(select, 'custom-api:openrouter')
    expect(onUpdate).toHaveBeenCalledWith({
      computerUse: expect.objectContaining({
        jev: expect.objectContaining({ providerId: 'custom-api:openrouter' }),
      }),
    })
  })

  it('offers a configuration entry when OpenRouter is not configured', async () => {
    const onConfigureProvider = vi.fn()
    const user = userEvent.setup()
    render(
      <ComputerUseGlobalSettings
        locale="en"
        value={{ enabled: true, strategy: 'jev', perception: 'disabled', jev: { enabled: true, fallback: 'fail_closed' } }}
        providers={[]}
        onConfigureProvider={onConfigureProvider}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Configure OpenRouter' }))
    expect(onConfigureProvider).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('option', { name: 'Not set' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OpenRouter' })).not.toBeInTheDocument()
  })

  it('keeps an unconfigured Jev provider visible as unavailable', () => {
    render(
      <ComputerUseGlobalSettings
        locale="en"
        value={{ enabled: true, strategy: 'jev', perception: 'disabled', jev: { enabled: true, fallback: 'fail_closed', providerId: 'custom-api:gone' } }}
        providers={[]}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.getByRole('option', { name: 'custom-api:gone (unavailable)' })).toBeInTheDocument()
  })
})
