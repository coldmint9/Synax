import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GoalQuickApproval } from '../GoalQuickApproval'
import type { PermissionDecision } from '../../../../../lib/api/agentRuntime'
vi.mock('../../../../../hooks/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))
const permission = (allowedReplies?: string[]) => ({ id: 'p1', action: 'ask', patterns: ['echo hello'], resolvedAt: null,
  metadata: allowedReplies ? { allowedReplies } : {} }) as PermissionDecision

describe('native approval capability UI', () => {
  it('does not offer always when the CLI only supports this operation', async () => {
    const onReply = vi.fn()
    render(<GoalQuickApproval permissions={[permission(['once', 'reject'])]} onReply={onReply} />)
    expect(screen.queryByRole('button', { name: 'permAlwaysAllow' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'permAllowOnce' }))
    expect(onReply).toHaveBeenCalledWith('p1', 'once')
  })
  it('retains legacy Native approval choices and explicit session approval support', () => {
    const view = render(<GoalQuickApproval permissions={[permission()]} onReply={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'permAlwaysAllow' })).toBeInTheDocument()
    view.rerender(<GoalQuickApproval permissions={[permission(['once', 'always', 'reject'])]} onReply={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'permAlwaysAllow' })).toBeInTheDocument()
  })
})
