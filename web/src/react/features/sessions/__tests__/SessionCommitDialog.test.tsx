import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionGitCommitResult } from '../../../../lib/api/agentRuntime'
import { useShellStore } from '../../../state/shellStore'

const commitSessionWorkspace = vi.fn()

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    commitSessionWorkspace: (...args: unknown[]) => commitSessionWorkspace(...args),
  },
}))

const { SessionCommitDialog } = await import('../SessionCommitDialog')

const committed: SessionGitCommitResult = {
  commitSha: '5e5727b0abcdef0123456789',
  branch: 'feature/commit-ui',
  upstream: 'origin/feature/commit-ui',
}

function renderDialog(props: Partial<React.ComponentProps<typeof SessionCommitDialog>> = {}) {
  const onClose = vi.fn()
  const onCommitted = vi.fn()
  render(
    <SessionCommitDialog
      isOpen
      sessionId="session-1"
      branch="feature/commit-ui"
      changedFiles={3}
      onClose={onClose}
      onCommitted={onCommitted}
      {...props}
    />,
  )
  return { onClose, onCommitted }
}

describe('SessionCommitDialog', () => {
  beforeEach(() => {
    cleanup()
    commitSessionWorkspace.mockReset()
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: 'zh' } }))
  })

  it('shows the target branch, the change count and the auto-generate hint', () => {
    renderDialog()

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('feature/commit-ui')).toBeTruthy()
    expect(screen.getByText('3 个文件已变更')).toBeTruthy()
    expect(screen.getByText('可选')).toBeTruthy()
    expect(screen.getByLabelText('提交信息')).toBeTruthy()
  })

  it('falls back to the empty-state copy and disables commit when nothing changed', () => {
    renderDialog({ changedFiles: 0 })

    expect(screen.getByText('没有可提交的变更')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: '提交并推送' })
    expect(confirm).toBeDisabled()
  })

  it('asks the model to write the message when the input is left empty', async () => {
    commitSessionWorkspace.mockResolvedValue(committed)
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))

    await waitFor(() => expect(commitSessionWorkspace).toHaveBeenCalledWith('session-1', {}))
  })

  it('sends a trimmed message and reports the pushed commit', async () => {
    commitSessionWorkspace.mockResolvedValue(committed)
    const { onCommitted } = renderDialog()

    fireEvent.change(screen.getByLabelText('提交信息'), { target: { value: '  fix: dialog layout  ' } })
    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))

    await waitFor(() =>
      expect(commitSessionWorkspace).toHaveBeenCalledWith('session-1', { message: 'fix: dialog layout' }),
    )
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('5e5727b0')
    expect(status.textContent).toContain('origin/feature/commit-ui')
    expect(onCommitted).toHaveBeenCalledWith(committed)
  })

  it('surfaces a failed commit as an alert and keeps the form usable', async () => {
    commitSessionWorkspace.mockRejectedValue(new Error('remote rejected the push'))
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('remote rejected the push')
    expect(screen.getByLabelText('提交信息')).toBeTruthy()
  })
})
