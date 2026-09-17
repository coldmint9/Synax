import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi, type AgentInteraction, type AgentSession } from '../../../../lib/api/agentRuntime'
import type { Subscription } from '../../../../lib/api/runtimeEventBus'
import { useAgentSessionStore } from '../agentSessionStore'
import { AgentInteractionPanel } from '../AgentInteractionPanel'

const bus = vi.hoisted(() => ({ subscription: null as Subscription | null }))
vi.mock('../../../../lib/api/runtimeEventBus', () => ({
  subscribe: (subscription: Subscription) => { bus.subscription = subscription; return vi.fn() },
}))
vi.mock('../../../../lib/api/sessionLiveClient', () => ({ ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn() }))
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }))

const session: AgentSession = {
  id: 's1', projectId: 'p1', parentSessionId: null, childSessionIds: [], nodeId: null,
  profileId: 'synax', status: 'waiting_input', title: null, prompt: 'Task', contextSnapshotId: null,
  thinkingMode: 'standard', createdAt: '', updatedAt: '', completedAt: null, resultSummary: null,
  blockedReason: null, skillIds: [], activeRunId: 'r1', pendingResumeToken: null, model: null,
  sessionMetadata: { mode: 'plan' },
}
const clarification: AgentInteraction = {
  id: 'i1', sessionId: 's1', runId: 'r1', stepId: 'step1', toolCallId: 'tool1',
  kind: 'clarification', revision: 3, status: 'pending', response: null, createdAt: '', resolvedAt: null,
  request: { title: 'Clarify scope', questions: [
    { id: 'name', type: 'text', label: 'Name', required: true, min: 2, max: 10 },
    { id: 'notes', type: 'textarea', label: 'Notes' },
    { id: 'count', type: 'number', label: 'Count', required: true, min: 1, max: 5 },
    { id: 'confirm', type: 'boolean', label: 'Confirmed', required: true },
    { id: 'target', type: 'single_select', label: 'Target', required: true, allowOther: true, options: [{ value: 'web', label: 'Web' }] },
    { id: 'checks', type: 'multi_select', label: 'Checks', required: true, min: 1, max: 2, allowOther: true, options: [{ value: 'unit', label: 'Unit' }, { value: 'ui', label: 'UI' }] },
  ] },
}
const plan: AgentInteraction = {
  ...clarification, id: 'plan1', kind: 'plan_approval', request: { title: 'Approve plan', plan: {
    title: 'Ship forms', objective: 'Durable answers',
    steps: [{ id: 'one', title: 'Implement UI', description: 'Native inputs', dependsOn: [], expectedFiles: ['form.tsx'] }],
    acceptanceCriteria: ['Reload retains requests'], assumptions: ['API available'], risks: ['Stale revision'],
  } },
}

beforeEach(() => {
  vi.restoreAllMocks()
  useAgentSessionStore.setState({
    projectId: null, sessions: [session], selectedSessionId: session.id, interactionState: null,
  })
  vi.spyOn(agentRuntimeApi, 'listInteractions').mockResolvedValue({ interactions: [clarification] })
  vi.spyOn(agentRuntimeApi, 'replyInteraction').mockImplementation(async (_sessionId, _id, body) => ({
    interaction: { ...clarification, status: 'answered', response: body },
  }))
})

async function fillForm() {
  const user = userEvent.setup()
  await screen.findByRole('textbox', { name: 'Name' })
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Synax')
  await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Keep inputs')
  await user.type(screen.getByRole('spinbutton', { name: 'Count' }), '2')
  await user.click(within(screen.getByRole('group', { name: 'Confirmed *' })).getByRole('radio', { name: 'No' }))
  await user.click(screen.getByRole('radio', { name: 'Web' }))
  await user.click(screen.getByRole('checkbox', { name: 'Unit' }))
  return user
}

describe('AgentInteractionPanel', () => {
  it.each(['codex', 'claude-code'])('loads and answers persisted questions for the %s native CLI backend', async backendId => {
    const nativeSession = { ...session, sessionMetadata: { mode: 'chat', backend: { id: backendId, version: 1, model: null, workDir: '/tmp' } } }
    useAgentSessionStore.setState({ sessions: [nativeSession] })
    render(<AgentInteractionPanel session={nativeSession} />)
    const user = await fillForm()
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'i1', expect.objectContaining({ revision: 3, action: 'submit' })))
  })

  it('keeps unsupported ACP forms hidden', () => {
    render(<AgentInteractionPanel session={{ ...session, sessionMetadata: { backend: { id: 'codex-acp', version: 1 } } }} />)
    expect(agentRuntimeApi.listInteractions).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Agent requests' })).not.toBeInTheDocument()
  })

  it('renders no empty panel or loading placeholder when the session is idle', () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockReturnValue(new Promise(() => {}))
    render(<AgentInteractionPanel session={{ ...session, status: 'completed' }} />)
    expect(screen.queryByRole('region', { name: 'Agent requests' })).not.toBeInTheDocument()
    expect(screen.queryByText('Loading requests…')).not.toBeInTheDocument()
  })

  it('reloads durable questions and submits typed answers with the exact revision', async () => {
    render(<AgentInteractionPanel session={session} />)
    const user = await fillForm()
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'i1', {
      revision: 3, action: 'submit', answers: { name: 'Synax', notes: 'Keep inputs', count: 2, confirm: false, target: 'web', checks: ['unit'] },
    }))
  })

  it('validates required fields and numeric bounds without posting', async () => {
    render(<AgentInteractionPanel session={session} />)
    await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(await screen.findAllByText('Required')).not.toHaveLength(0)
    expect(agentRuntimeApi.replyInteraction).not.toHaveBeenCalled()
    const user = await fillForm()
    await user.clear(screen.getByRole('spinbutton', { name: 'Count' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Count' }), '8')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(screen.getByRole('spinbutton', { name: 'Count' })).toHaveAttribute('aria-invalid', 'true')
    expect(agentRuntimeApi.replyInteraction).not.toHaveBeenCalled()
  })

  it('preserves values on server failure and refresh, then permits retry', async () => {
    vi.mocked(agentRuntimeApi.replyInteraction).mockRejectedValueOnce(new Error('Revision conflict; please retry'))
    render(<AgentInteractionPanel session={session} />)
    const user = await fillForm()
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict')
    act(() => bus.subscription?.events?.session_changed?.({ data: JSON.stringify({ sessionId: 's1' }) } as MessageEvent))
    await waitFor(() => expect(agentRuntimeApi.listInteractions).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Synax')
    expect(within(screen.getByRole('group', { name: 'Confirmed *' })).getByRole('radio', { name: 'No' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledTimes(2))
  })

  it.each([['Skip', 'decline'], ['Cancel request', 'cancel']])('supports %s without filling required answers', async (label, action) => {
    render(<AgentInteractionPanel session={session} />)
    fireEvent.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'i1', { revision: 3, action }))
  })

  it.each([['Execute', 'execute'], ['Cancel', 'cancel']])('keeps %s as a one-time plan action', async (label, action) => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [plan] })
    render(<AgentInteractionPanel session={session} />)
    expect(await screen.findByText('Durable answers')).toBeVisible()
    expect(screen.getByText('form.tsx')).toBeVisible()
    expect(screen.getByText('Reload retains requests')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Request revision' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Revision feedback' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'plan1', {
      revision: 3, action,
    }))
  })

  it('reports loading errors and retries the durable request', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockRejectedValueOnce(new Error('Offline'))
    render(<AgentInteractionPanel session={session} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeVisible()
  })

  it('disables a pending form for a cancelled session', async () => {
    render(<AgentInteractionPanel session={{ ...session, status: 'cancelled' }} />)
    expect(await screen.findByRole('button', { name: 'Submit answers' })).toBeDisabled()
    expect(agentRuntimeApi.replyInteraction).not.toHaveBeenCalled()
  })

  it('supports other values and validates multi-select cardinality', async () => {
    render(<AgentInteractionPanel session={session} />)
    const user = await fillForm()
    await user.click(within(screen.getByRole('group', { name: 'Target *' })).getByRole('radio', { name: 'Other' }))
    await user.type(screen.getByRole('textbox', { name: 'Target — Other' }), 'Desktop')
    await user.click(screen.getByRole('checkbox', { name: 'UI' }))
    await user.click(within(screen.getByRole('group', { name: 'Checks *' })).getByRole('checkbox', { name: 'Other' }))
    await user.type(screen.getByRole('textbox', { name: 'Checks — Other' }), 'Accessibility')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(agentRuntimeApi.replyInteraction).not.toHaveBeenCalled()
    expect(screen.getByText('Out of bounds (min 1, max 2)')).toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: 'UI' }))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'i1', expect.objectContaining({
      answers: expect.objectContaining({ target: 'Desktop', checks: ['unit', 'Accessibility'] }),
    })))
  })

  it('does not confuse numeric zero or false with an absent answer, and omits empty optional fields', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [{ ...clarification, request: { title: 'Zero is valid', questions: [
      { id: 'count', type: 'number', label: 'Count', required: true, min: 0 },
      { id: 'confirm', type: 'boolean', label: 'Confirmed', required: true },
      { id: 'notes', type: 'textarea', label: 'Optional notes', required: false },
    ] } }] })
    render(<AgentInteractionPanel session={session} />)
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Count' }), { target: { value: '0' } })
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirmed *' })).getByRole('radio', { name: 'No' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'i1', { revision: 3, action: 'submit', answers: { count: 0, confirm: false } }))
  })

  it('retains answered and declined history alongside pending forms after reload', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [
      { ...clarification, id: 'old', revision: 1, status: 'answered', response: { revision: 1, action: 'submit', answers: { name: 'Earlier answer', confirm: false } } },
      { ...plan, status: 'answered', response: { revision: 3, action: 'save' } },
      { ...clarification, id: 'declined', revision: 2, status: 'declined', response: { revision: 2, action: 'decline' } },
      clarification,
    ] })
    const { unmount } = render(<AgentInteractionPanel session={session} />)
    fireEvent.click(await screen.findByText('Interaction history'))
    fireEvent.click(screen.getByLabelText('Clarify scope v1 — Answered'))
    expect(screen.getByText('Earlier answer')).toBeVisible()
    expect(screen.getByLabelText('Approve plan v3 — Saved for later execution')).toBeVisible()
    expect(screen.getByLabelText('Clarify scope v2 — Declined')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Submit answers' })).toHaveLength(1)
    unmount()
    useAgentSessionStore.setState({ interactionState: null })
    render(<AgentInteractionPanel session={session} />)
    expect(await screen.findByLabelText('Approve plan v3 — Saved for later execution')).not.toBeVisible()
    fireEvent.click(screen.getByText('Interaction history'))
    expect(screen.getByLabelText('Approve plan v3 — Saved for later execution')).toBeVisible()
  })

  it('refreshes on reconnect and same-session events, not another session’s events', async () => {
    render(<AgentInteractionPanel session={session} />)
    await screen.findByRole('textbox', { name: 'Name' })
    act(() => bus.subscription?.events?.session_changed?.({ data: JSON.stringify({ sessionId: 'other' }) } as MessageEvent))
    expect(agentRuntimeApi.listInteractions).toHaveBeenCalledTimes(1)
    act(() => bus.subscription?.onConnect?.())
    await waitFor(() => expect(agentRuntimeApi.listInteractions).toHaveBeenCalledTimes(2))
    act(() => bus.subscription?.events?.session_step_completed?.({ data: JSON.stringify({ sessionId: 's1' }) } as MessageEvent))
    await waitFor(() => expect(agentRuntimeApi.listInteractions).toHaveBeenCalledTimes(3))
  })

  it('does not carry draft answers to a different session or a new revision', async () => {
    const { rerender } = render(<AgentInteractionPanel session={session} />)
    await fillForm()
    const second = { ...session, id: 's2' }
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [{ ...clarification, sessionId: 's2' }] })
    act(() => useAgentSessionStore.setState({ selectedSessionId: 's2', sessions: [second] }))
    rerender(<AgentInteractionPanel session={second} />)
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Old revision' } })
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [{ ...clarification, sessionId: 's2', revision: 4 }] })
    rerender(<AgentInteractionPanel session={{ ...second, updatedAt: 'new-revision' }} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(''))
  })

  it('does not submit the same revision twice while a reply is pending', async () => {
    let resolve!: (value: { interaction: AgentInteraction }) => void
    vi.mocked(agentRuntimeApi.replyInteraction).mockReturnValue(new Promise(r => { resolve = r }))
    render(<AgentInteractionPanel session={session} />)
    await fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    await act(async () => resolve({ interaction: { ...clarification, status: 'answered' } }))
  })

  it('keeps the execute-or-cancel plan actions outside the scrolling body', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [plan] })
    render(<AgentInteractionPanel session={session} />)
    const execute = await screen.findByRole('button', { name: 'Execute' })
    expect(execute.closest('.agent-request-body')).toBeNull()
    expect(execute.closest('footer')).toHaveTextContent('cancel this shortcut')
    expect(execute.closest('form')).not.toHaveClass('border-warning/40')
  })

  it('marks human acceptance criteria without adding a new reply contract', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [{ ...plan, request: { ...plan.request, plan: {
      ...plan.request.plan!, humanAcceptanceCriteria: ['Reload retains requests'],
    } } }] })
    render(<AgentInteractionPanel session={session} />)
    expect(await screen.findByText('(user confirmation)')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
    await waitFor(() => expect(agentRuntimeApi.replyInteraction).toHaveBeenCalledWith('s1', 'plan1', { revision: 3, action: 'execute' }))
  })

  it('loads after the parent selects the session, even if the panel mounted before selection', async () => {
    useAgentSessionStore.setState({ selectedSessionId: null })
    render(<AgentInteractionPanel session={session} />)
    expect(agentRuntimeApi.listInteractions).not.toHaveBeenCalled()
    act(() => useAgentSessionStore.setState({ selectedSessionId: session.id }))
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeVisible()
  })
})
