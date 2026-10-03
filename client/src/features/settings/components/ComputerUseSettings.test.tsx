import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseSettings } from './ComputerUseSettings'

afterEach(() => { Reflect.deleteProperty(window, 'electronAPI') })

describe('Computer Use settings', () => {
  it('defaults to Direct Cua without a Jev credential or client call', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const getComputerUseStatus = vi.fn().mockResolvedValue({ state: 'ready', error: null })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUseStatus } })
    render(<ComputerUseSettings locale="en" onSave={onSave} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ready'))
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

  it('shows system authorization steps and opens both permission pages when access is missing', async () => {
    const openComputerUsePermissions = vi.fn().mockResolvedValue(undefined)
    const getComputerUseStatus = vi.fn().mockResolvedValue({
      state: 'unavailable',
      error: 'Grant Synax Accessibility and Screen Recording in macOS System Settings, then relaunch Synax.',
    })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUseStatus, openComputerUsePermissions } })
    render(<ComputerUseSettings locale="zh-CN" onSave={vi.fn().mockResolvedValue(undefined)} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('list')).toBeInTheDocument()
    expect(within(alert).getAllByRole('listitem')).toHaveLength(3)
    expect(within(alert).getByText('授权后退出并重新打开 Synax，再确认状态为“已就绪”。')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(alert).getByRole('button', { name: '打开辅助功能' }))
    await user.click(within(alert).getByRole('button', { name: '打开屏幕录制' }))
    expect(openComputerUsePermissions).toHaveBeenNthCalledWith(1, 'accessibility')
    expect(openComputerUsePermissions).toHaveBeenNthCalledWith(2, 'screen-recording')
  })

  it('does not show authorization tips when the driver is ready', async () => {
    const getComputerUseStatus = vi.fn().mockResolvedValue({ state: 'ready', error: null })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getComputerUseStatus } })
    render(<ComputerUseSettings locale="en" onSave={vi.fn().mockResolvedValue(undefined)} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ready'))
    expect(screen.queryByRole('button', { name: 'Open Accessibility' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

})
