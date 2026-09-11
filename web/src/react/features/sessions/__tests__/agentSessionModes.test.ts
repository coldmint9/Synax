import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi, type AgentInteraction, type AgentSession } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore, isSessionUnread } from '../agentSessionStore'
import { canSwitchSessionMode, canEnqueueSessionInput, isSessionComposerLocked } from '../sessionComposerState'
import { isGoalModeSession } from '../sessionBuckets'

vi.mock('../../../../lib/api/sessionLiveClient', () => ({ ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn() }))

const session: AgentSession = {
  id: 's1', projectId: 'p1', parentSessionId: null, childSessionIds: [], nodeId: null, profileId: 'synax',
  status: 'completed', title: null, prompt: 'Task', contextSnapshotId: null, thinkingMode: 'standard',
  createdAt: '', updatedAt: '', completedAt: null, resultSummary: null, blockedReason: null, skillIds: [],
  activeRunId: null, pendingResumeToken: null, model: null, sessionMetadata: { mode: 'chat', permissionTier: 'readonly' },
}
const interaction: AgentInteraction = {
  id: 'i1', sessionId: 's1', runId: 'r1', stepId: 'step1', toolCallId: 'tool1', kind: 'clarification',
  revision: 1, status: 'pending', request: { title: 'Question', questions: [] }, response: null, createdAt: '', resolvedAt: null,
}

beforeEach(() => {
  vi.restoreAllMocks()
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), sessions: [session], selectedSessionId: 's1',
    interactionState: { sessionId: 's1', items: [], loading: false, error: null },
  })
})

describe('session mode boundaries', () => {
  it.each(['running', 'queued', 'waiting_input', 'waiting_permission'] as const)('does not switch while %s', status => {
    expect(canSwitchSessionMode({ ...session, status })).toBe(false)
  })
  it('only permits an idle native primary without pending input or permissions', () => {
    expect(canSwitchSessionMode(session)).toBe(true)
    expect(canSwitchSessionMode(session, { hasPendingInteractions: true })).toBe(false)
    expect(canSwitchSessionMode(session, { hasPendingPermissions: true })).toBe(false)
    expect(canSwitchSessionMode({ ...session, activeRunId: 'r1' })).toBe(false)
    expect(canSwitchSessionMode({ ...session, pendingResumeToken: 'interaction:i1' })).toBe(false)
    expect(canSwitchSessionMode({ ...session, parentSessionId: 'parent' })).toBe(false)
    expect(canSwitchSessionMode({ ...session, sessionMetadata: { mode: 'plan_node' } })).toBe(false)
    expect(canSwitchSessionMode({ ...session, model: 'codex-acp/default' })).toBe(false)
    expect(canSwitchSessionMode({ ...session, sessionMetadata: { acp: { engineModel: 'pi-acp/default' } } })).toBe(false)
    expect(canSwitchSessionMode(undefined, { acp: true })).toBe(false)
  })
  it('marks waiting input unread and locks free text rather than enqueueing default answers', () => {
    const waiting = { ...session, status: 'waiting_input' as const }
    expect(isSessionComposerLocked(waiting)).toBe(true)
    expect(canEnqueueSessionInput(waiting)).toBe(false)
    expect(isSessionUnread(waiting, {})).toBe(true)
    expect(isSessionComposerLocked(session, { hasPendingInteractions: true })).toBe(true)
  })
  it('keeps plan sessions reachable through the existing composer route', () => {
    expect(isGoalModeSession({ ...session, sessionMetadata: { mode: 'plan' } })).toBe(true)
  })
  it.each(['chat', 'plan', 'goal'] as const)('creates %s mode in metadata without changing permissions', async mode => {
    vi.spyOn(agentRuntimeApi, 'createSession').mockResolvedValue({ session, profile: {} as never, context: null })
    useAgentSessionStore.getState().setDraftMode(mode)
    await useAgentSessionStore.getState().submitSessionDraft('p1', { message: 'Task', permissionTier: 'readonly' })
    expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(expect.objectContaining({
      permissionTier: 'readonly', sessionMetadata: expect.objectContaining({ mode }),
    }))
  })
  it('rejects non-chat ACP drafts before creating a session', async () => {
    vi.spyOn(agentRuntimeApi, 'createSession')
    await expect(useAgentSessionStore.getState().submitSessionDraft('p1', { message: 'Task', model: 'codex-acp/default', mode: 'goal' })).rejects.toThrow('native Synax')
    expect(agentRuntimeApi.createSession).not.toHaveBeenCalled()
  })
  it('uses the server mode metadata and preserves it if a later switch fails', async () => {
    vi.spyOn(agentRuntimeApi, 'updateSessionMode').mockResolvedValueOnce({ session: { ...session, sessionMetadata: { ...session.sessionMetadata, mode: 'goal', goal: {
      objective: 'Task', status: 'planning', maxSteps: 10, stepsUsed: 0, maxTokens: 1000, tokensUsed: 0,
    }, plan: null } } }).mockRejectedValueOnce(new Error('Run started'))
    await useAgentSessionStore.getState().updateSessionMode('s1', 'goal')
    expect(useAgentSessionStore.getState().sessions[0].sessionMetadata).toMatchObject({ mode: 'goal', permissionTier: 'readonly', goal: { status: 'planning' }, plan: null })
    await expect(useAgentSessionStore.getState().updateSessionMode('s1', 'plan')).rejects.toThrow('Run started')
    expect(useAgentSessionStore.getState().sessions[0].sessionMetadata?.mode).toBe('goal')
  })
  it.each([null, { sessionId: 's1', items: [interaction], loading: false, error: null }, { sessionId: 's1', items: [], loading: false, error: 'Offline' }])('fails closed before mode PATCH when pending requests are unknown or unresolved', async interactionState => {
    useAgentSessionStore.setState({ interactionState })
    vi.spyOn(agentRuntimeApi, 'updateSessionMode')
    await expect(useAgentSessionStore.getState().updateSessionMode('s1', 'plan')).rejects.toThrow('idle native session')
    expect(agentRuntimeApi.updateSessionMode).not.toHaveBeenCalled()
  })
  it('does not turn a durable waiting event followed by stream done into completion', async () => {
    useAgentSessionStore.setState({ sessions: [{ ...session, status: 'running', activeRunId: 'r1' }], refreshDetail: vi.fn(async () => {}) })
    vi.spyOn(agentRuntimeApi, 'streamTurn').mockImplementation(async (_id, _body, onChunk) => {
      onChunk({ type: 'event', event: { type: 'interaction_requested' } })
      onChunk({ type: 'done', sessionId: 's1', runId: 'r1' })
    })
    await useAgentSessionStore.getState().sendSessionMessage('s1', { message: 'Task' })
    expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: 'waiting_input', activeRunId: 'r1' })
  })
  it('keeps a declined round blocked when the failed/blocked event is followed by stream done', async () => {
    useAgentSessionStore.setState({ sessions: [{ ...session, status: 'running', activeRunId: 'r1' }], refreshDetail: vi.fn(async () => {}) })
    vi.spyOn(agentRuntimeApi, 'streamTurn').mockImplementation(async (_id, _body, onChunk) => {
      onChunk({ type: 'run_failed', run: { id: 'r1', status: 'blocked' }, error: 'User declined the requested input.' })
      onChunk({ type: 'done', sessionId: 's1', runId: 'r1' })
    })
    await useAgentSessionStore.getState().sendSessionMessage('s1', { message: 'Task' })
    expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: 'blocked', activeRunId: null, blockedReason: 'User declined the requested input.' })
  })
})

describe('durable interaction refresh races', () => {
  it('ignores an old GET after a reply has committed', async () => {
    let resolve!: (value: { interactions: AgentInteraction[] }) => void
    vi.spyOn(agentRuntimeApi, 'listInteractions').mockReturnValue(new Promise(r => { resolve = r }))
    useAgentSessionStore.setState({ interactionState: { sessionId: 's1', items: [interaction], loading: false, error: null } })
    const refresh = useAgentSessionStore.getState().refreshInteractions('s1')
    vi.spyOn(agentRuntimeApi, 'replyInteraction').mockResolvedValue({ interaction: { ...interaction, status: 'answered' } })
    await useAgentSessionStore.getState().replyInteraction('s1', 'i1', { revision: 1, action: 'submit', answers: {} })
    resolve({ interactions: [interaction] })
    await refresh
    expect(useAgentSessionStore.getState().interactionState?.items[0].status).toBe('answered')
  })
  it('does not put one session’s pending requests into a different session', async () => {
    let resolve!: (value: { interactions: AgentInteraction[] }) => void
    vi.spyOn(agentRuntimeApi, 'listInteractions').mockReturnValue(new Promise(r => { resolve = r }))
    const refresh = useAgentSessionStore.getState().refreshInteractions('s1')
    useAgentSessionStore.setState({ selectedSessionId: 's2', interactionState: null })
    resolve({ interactions: [interaction] })
    await refresh
    expect(useAgentSessionStore.getState().interactionState).toBeNull()
  })
})
