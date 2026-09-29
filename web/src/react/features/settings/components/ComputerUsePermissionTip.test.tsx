import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUsePermissionTip } from './ComputerUsePermissionTip'

describe('ComputerUsePermissionTip', () => {
  it('guides English users through both system permissions', async () => {
    const onOpenPermission = vi.fn()
    const user = userEvent.setup()
    render(<ComputerUsePermissionTip zh={false} onOpenPermission={onOpenPermission} />)

    expect(screen.getByText('Use the buttons below to open macOS System Settings.')).toBeInTheDocument()
    expect(screen.getByText('Find Synax in the list and enable the requested permission.')).toBeInTheDocument()
    expect(screen.getByText('After granting access, quit and reopen Synax, then check that the status is “Ready”.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open Accessibility' }))
    await user.click(screen.getByRole('button', { name: 'Open Screen Recording' }))
    expect(onOpenPermission).toHaveBeenNthCalledWith(1, 'accessibility')
    expect(onOpenPermission).toHaveBeenNthCalledWith(2, 'screen-recording')
  })

  it('renders localized Chinese guidance', () => {
    render(<ComputerUsePermissionTip zh onOpenPermission={vi.fn()} />)
    expect(screen.getByText('点击下方按钮打开 macOS 系统设置。')).toBeInTheDocument()
    expect(screen.getByText('在列表中找到 Synax，并开启对应的系统权限。')).toBeInTheDocument()
    expect(screen.getByText('授权后退出并重新打开 Synax，再确认状态为“已就绪”。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开辅助功能' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开屏幕录制' })).toBeInTheDocument()
  })
})
