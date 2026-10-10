import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseGlobalSettings } from './ComputerUseGlobalSettings'
import type { ProviderDef } from '../../../shared/contracts/config'

afterEach(() => { Reflect.deleteProperty(window, 'electronAPI') })

describe('Computer Use global settings', () => {
  it('defaults to disabled with advanced settings collapsed', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(<ComputerUseGlobalSettings locale="en" onUpdate={onUpdate} />)
    expect(screen.getByRole('checkbox', { name: /Enable Computer Use/ })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Computer Use strategy' })).toBeDisabled()
    await userEvent.setup().click(screen.getByText('Advanced settings · Jev assistance'))
    expect(screen.getByRole('combobox', { name: 'Visual perception' })).toHaveValue('disabled')
    expect(screen.getByRole('checkbox', { name: /Enable Jev/ })).not.toBeChecked()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('saves perception and Jev changes through the global config patch', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ComputerUseGlobalSettings locale="en" value={{ enabled: true, strategy: 'auto', perception: 'disabled' }} onUpdate={onUpdate} />)
    await user.click(screen.getByText('Advanced settings · Jev assistance'))
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
    await user.click(screen.getByText('Advanced settings · Jev assistance'))
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
    await user.click(screen.getByText('Advanced settings · Jev assistance'))
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
    await user.click(screen.getByText('Advanced settings · Jev assistance'))
    await user.click(screen.getByRole('button', { name: 'Configure OpenRouter' }))
    expect(onConfigureProvider).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('option', { name: 'Not set' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OpenRouter' })).not.toBeInTheDocument()
  })

  it('keeps an unconfigured Jev provider visible as unavailable', async () => {
    render(
      <ComputerUseGlobalSettings
        locale="en"
        value={{ enabled: true, strategy: 'jev', perception: 'disabled', jev: { enabled: true, fallback: 'fail_closed', providerId: 'custom-api:gone' } }}
        providers={[]}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    await userEvent.setup().click(screen.getByText('Advanced settings · Jev assistance'))
    expect(screen.getByRole('option', { name: 'custom-api:gone (unavailable)' })).toBeInTheDocument()
  })

  it('only opens permission settings after a click and uses the modern permission name', async () => {
    const openComputerUsePermissions = vi.fn().mockResolvedValue(undefined)
    const getComputerUsePermissions = vi.fn().mockResolvedValue({ platform: 'darwin', macOSMajorVersion: 27, accessibility: false, screenRecording: false, error: null })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUsePermissions, openComputerUsePermissions } })
    render(<ComputerUseGlobalSettings locale="zh-CN" onUpdate={vi.fn()} />)
    const link = await screen.findByRole('button', { name: '设备控制和数据访问 — 前往设置' })
    expect(openComputerUsePermissions).not.toHaveBeenCalled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    expect(openComputerUsePermissions).not.toHaveBeenCalled()
    await user.click(link)
    expect(openComputerUsePermissions).toHaveBeenCalledWith('accessibility')
    await user.click(screen.getByRole('button', { name: '屏幕与系统音频录制 — 前往设置' }))
    expect(openComputerUsePermissions).toHaveBeenLastCalledWith('screen-recording')
  })

  it('keeps the global switch off even if the runtime is ready and saves explicit opt-in', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const getComputerUseStatus = vi.fn().mockResolvedValue({ state: 'ready', error: null })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUseStatus } })
    render(<ComputerUseGlobalSettings locale="en" onUpdate={onUpdate} />)
    await waitFor(() => expect(getComputerUseStatus).toHaveBeenCalled())
    expect(screen.getByRole('status')).toHaveTextContent('Off')
    await userEvent.setup().click(screen.getByRole('checkbox', { name: /Enable Computer Use/ }))
    expect(onUpdate).toHaveBeenCalledWith({ computerUse: { enabled: true, strategy: 'auto', perception: 'disabled' } })
  })
})
