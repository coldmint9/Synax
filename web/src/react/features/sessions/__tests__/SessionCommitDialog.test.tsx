import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  message: 'fix: dialog layout',
  messageGenerated: false,
  pushed: true,
  branch: 'feature/commit-ui',
  upstream: 'origin/feature/commit-ui',
  committedFiles: 3,
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
    expect(screen.getByRole('button', { name: '仅提交' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交并推送' })).toBeTruthy()
  })

  it('falls back to the empty-state copy and disables commit when nothing changed', () => {
    renderDialog({ changedFiles: 0 })

    expect(screen.getByText('没有可提交的变更')).toBeTruthy()
    expect(screen.getByRole('button', { name: '仅提交' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '提交并推送' })).toBeDisabled()
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

  it('commits without pushing when only-commit is chosen', async () => {
    commitSessionWorkspace.mockResolvedValue({
      ...committed,
      pushed: null,
      upstream: null,
    } satisfies SessionGitCommitResult)
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '仅提交' }))

    await waitFor(() =>
      expect(commitSessionWorkspace).toHaveBeenCalledWith('session-1', { push: false }),
    )
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已在本地提交')
    expect(status.textContent).toContain('尚未推送到远端')
  })

  it('surfaces a failed commit as an alert and keeps the form usable', async () => {
    commitSessionWorkspace.mockRejectedValue(new Error('remote rejected the push'))
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('remote rejected the push')
    expect(screen.getByLabelText('提交信息')).toBeTruthy()
  })

  it.each(['success', 'failure'])('ignores a stale %s after switching repositories and only submits once', async outcome => {
    let finish!: (value: SessionGitCommitResult) => void
    let fail!: (error: Error) => void
    commitSessionWorkspace.mockReturnValueOnce(new Promise<SessionGitCommitResult>((resolve, reject) => { finish = resolve; fail = reject }))
    const props = { isOpen: true, sessionId: 'session-1', branch: 'main', changedFiles: 3, onClose: vi.fn(), onCommitted: vi.fn() }
    const { rerender } = render(<SessionCommitDialog {...props} rootId="primary" rootName="API" />)
    const submit = screen.getByRole('button', { name: '仅提交' })
    act(() => { fireEvent.click(submit); fireEvent.click(submit) })
    expect(commitSessionWorkspace).toHaveBeenCalledTimes(1)
    expect(commitSessionWorkspace).toHaveBeenCalledWith('session-1', { rootId: 'primary', push: false })

    rerender(<SessionCommitDialog {...props} rootId="secondary" rootName="Web" />)
    expect(screen.getByText('Web')).toBeInTheDocument()
    await act(async () => {
      if (outcome === 'success') finish(committed)
      else fail(new Error('old repository failure'))
    })
    expect(props.onCommitted).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    commitSessionWorkspace.mockResolvedValueOnce({ ...committed, rootId: 'secondary' })
    fireEvent.click(screen.getByRole('button', { name: '仅提交' }))
    await waitFor(() => expect(props.onCommitted).toHaveBeenCalledWith({ ...committed, rootId: 'secondary' }))
    expect(commitSessionWorkspace).toHaveBeenLastCalledWith('session-1', { rootId: 'secondary', push: false })
  })
})
