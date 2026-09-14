import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeRecoveryPanel } from '../RuntimeRecoveryPanel'
import { agentRuntimeApi, type AgentSession } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore } from '../agentSessionStore'
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en' }) }))

describe('explicit execution recovery', () => {
  it('requires both confirmations and does not submit a new run', async () => {
    const session = { id: 'recovery', sessionMetadata: { runtimeControl: { state: 'unconfirmed', reason: 'Review changes.' } } } as AgentSession
    const recover = vi.spyOn(agentRuntimeApi, 'acknowledgeRecovery').mockResolvedValue({ session: { ...session, status: 'interrupted', sessionMetadata: {} } })
    const submit = vi.spyOn(agentRuntimeApi, 'submitRun')
    useAgentSessionStore.setState({ refreshSessions: vi.fn(async () => {}), refreshDetail: vi.fn(async () => {}), patchSession: vi.fn(() => true) })
    render(<RuntimeRecoveryPanel session={session} />)
    const button = screen.getByRole('button', { name: /Release recovery block/ })
    expect(button).toBeDisabled()
    for (const checkbox of screen.getAllByRole('checkbox')) await userEvent.click(checkbox)
    await userEvent.click(button)
    await waitFor(() => expect(recover).toHaveBeenCalledWith('recovery'))
    expect(submit).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
