import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi, type AgentSession } from '../../../../lib/api/agentRuntime'
import { goalApi } from '../../../../lib/api/goal'
import { useAgentSessionStore } from '../agentSessionStore'
import { useWikiStore } from '../../../state/wikiStore'
import { SessionComposer } from '../SessionComposer'
import { SessionModeSummary } from '../SessionWorkspace'

vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'en', t: (key: string) => key }) }))
vi.mock('../../../../lib/api/runtimeEventBus', () => ({ subscribe: () => vi.fn() }))
vi.mock('../../../../lib/api/sessionLiveClient', () => ({ ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn() }))
vi.mock('../../wiki/goal/useAcpDiscovery', () => ({ prefetchAcpDiscoveryIdle: vi.fn() }))
vi.mock('../../settings/useConfig', () => ({ useConfig: () => ({
  providers: [{ id: 'api', kind: 'api' }, { id: 'codex-acp', kind: 'acp' }], globalConfig: null, effectiveConfig: null,
}) }))
vi.mock('../../wiki/goal/GoalComposerPill', () => ({ GoalComposerPill: (props: {
  modeControl?: ReactNode; content: string; onContentChange: (value: string) => void; onSubmit: () => void; disabled: boolean
}) => <form onSubmit={event => { event.preventDefault(); props.onSubmit() }}>
  {props.modeControl}
  <textarea aria-label="Message" value={props.content} disabled={props.disabled} onChange={event => props.onContentChange(event.target.value)} />
  <button type="submit" disabled={props.disabled}>Send</button>
</form> }))

const session: AgentSession = {
  id: 's1', projectId: 'p1', parentSessionId: null, childSessionIds: [], nodeId: null, profileId: 'synax',
  status: 'completed', title: null, prompt: 'Task', contextSnapshotId: null, thinkingMode: 'standard',
  createdAt: '', updatedAt: '', completedAt: null, resultSummary: null, blockedReason: null, skillIds: [],
  activeRunId: null, pendingResumeToken: null, model: 'test-model', sessionMetadata: { mode: 'chat' },
}

beforeEach(() => {
  vi.restoreAllMocks()
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), sessions: [session], selectedSessionId: 's1' })
  useWikiStore.setState({
    goalComposerProviderId: 'api', goalComposerModelId: 'test-model', goalComposerPermissionTier: 'readonly',
    goalComposerReasoningEffort: 'high', goalComposerWikiAttachMode: 'auto', goalComposerDocumentId: null,
    documents: [], loadProjectSnapshot: vi.fn(async () => {}),
  })
  vi.spyOn(agentRuntimeApi, 'listInteractions').mockResolvedValue({ interactions: [] })
  vi.spyOn(agentRuntimeApi, 'listInputQueue').mockResolvedValue({ items: [] })
})

const renderComposer = (existing?: AgentSession) => render(<MemoryRouter><SessionComposer session={existing} projectId="p1" /></MemoryRouter>)

describe('SessionComposer mode controls', () => {
  it.each(['plan', 'goal'] as const)('sends the selected draft %s mode through createSession metadata', async mode => {
    vi.spyOn(goalApi, 'buildSessionPrompt').mockResolvedValue({ prompt: 'Scaffold', wikiContext: { mode: 'auto', documentId: null } } as never)
    vi.spyOn(agentRuntimeApi, 'createSession').mockResolvedValue({ session, context: null, profile: {} as never })
    useAgentSessionStore.setState({ sendSessionMessage: vi.fn(async () => {}) })
    renderComposer()
    await userEvent.click(screen.getByRole('button', { name: 'Session mode' }))
    await userEvent.click(await screen.findByRole('option', { name: mode === 'plan' ? 'Plan' : 'Goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Build forms' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionMetadata: expect.objectContaining({ mode, goalContent: 'Build forms' }), permissionTier: 'readonly',
    })))
  })

  it('disables ACP mode selection and sends ACP drafts as chat without discarding the native draft choice', () => {
    useAgentSessionStore.setState({ draftMode: 'plan' })
    useWikiStore.setState({ goalComposerProviderId: 'codex-acp', goalComposerModelId: 'default' })
    renderComposer()
    expect(screen.getByRole('button', { name: 'Session mode' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Session mode' })).toHaveAttribute('data-mode', 'chat')
    expect(useAgentSessionStore.getState().draftMode).toBe('plan')
  })

  it('disables a live session’s mode selector, even when activeRunId is temporarily absent', async () => {
    renderComposer({ ...session, status: 'running' })
    await waitFor(() => expect(agentRuntimeApi.listInteractions).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Session mode' })).toBeDisabled()
  })

  it('disables mode and free-text input while a durable form is pending, even before the status patch arrives', async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({ interactions: [{
      id: 'i1', sessionId: 's1', runId: 'r1', stepId: 'step1', toolCallId: 'tool1', revision: 1,
      kind: 'clarification', status: 'pending', response: null, createdAt: '', resolvedAt: null,
      request: { title: 'Question', questions: [{ id: 'q1', type: 'text', label: 'Answer' }] },
    }] })
    renderComposer(session)
    await screen.findByRole('textbox', { name: 'Answer' })
    expect(screen.getByRole('button', { name: 'Session mode' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled()
  })

  it('retains the existing mode and composer text when a safe idle switch is rejected by the server', async () => {
    vi.spyOn(agentRuntimeApi, 'updateSessionMode').mockRejectedValue(new Error('Run started; mode is locked'))
    renderComposer(session)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Session mode' })).toBeEnabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep my draft' } })
    await userEvent.click(screen.getByRole('button', { name: 'Session mode' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Plan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Run started')
    expect(screen.getByRole('button', { name: 'Session mode' })).toHaveAttribute('data-mode', 'chat')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep my draft')
  })

  it('renders server-refreshed goal budgets and specialist role without inferring goal completion from the run', () => {
    const goalSession = { ...session, sessionMetadata: {
      mode: 'goal' as const, goal: { objective: 'Ship safely', status: 'executing' as const, stepsUsed: 4, maxSteps: 10, tokensUsed: 200, maxTokens: 1000 },
      specialist: { name: 'Reviewer', role: 'Security review' },
    } }
    const { rerender } = render(<SessionModeSummary session={goalSession} />)
    expect(screen.getByRole('status')).toHaveTextContent('Executing')
    expect(screen.getByRole('progressbar', { name: 'Step budget' })).not.toBeVisible()
    fireEvent.click(screen.getByText('Ship safely', { selector: 'summary span' }).closest('summary')!)
    expect(screen.getByRole('progressbar', { name: 'Step budget' })).toHaveAttribute('value', '4')
    expect(screen.getByRole('progressbar', { name: 'Token budget' })).toHaveAttribute('max', '1000')
    expect(screen.getByText('Specialist: Reviewer')).toBeVisible()
    expect(screen.getByText('— Security review')).toBeVisible()
    act(() => rerender(<SessionModeSummary session={{ ...goalSession, sessionMetadata: { ...goalSession.sessionMetadata,
      goal: { ...goalSession.sessionMetadata.goal, status: 'budget_exhausted', stepsUsed: 10, reason: 'Step limit reached' },
    } }} />))
    expect(screen.getByRole('status')).toHaveTextContent('Budget exhausted')
    expect(screen.getByText('Step limit reached')).toBeVisible()
  })
})
