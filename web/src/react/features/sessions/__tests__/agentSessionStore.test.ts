import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore } from '../agentSessionStore'

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({ items: [], totalCount: 0, countByStatus: {} })),
    createSession: vi.fn(async (body) => ({
      session: {
        id: 'ars_new',
        projectId: body.projectId,
        parentSessionId: null,
        childSessionIds: [],
        nodeId: null,
        profileId: body.profileId,
        status: 'running',
        title: null,
        prompt: body.prompt,
        contextSnapshotId: null,
        thinkingMode: 'standard',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        completedAt: null,
        resultSummary: null,
        blockedReason: null,
        skillIds: body.skillIds ?? [],
        activeRunId: null,
        pendingResumeToken: null,
        sessionMetadata: body.sessionMetadata ?? null,
      },
    })),
  },
}))

afterEach(() => {
  useAgentSessionStore.setState({
    projectId: null,
    sessions: [],
    selectedSessionId: null,
    panelOpen: false,
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    childSessions: {},
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionCapabilities: null,
    readSessionMarkers: {},
    sessionDetailCache: {},
    streamingStepId: null,
    streamingLive: { blocks: [], pendingThinking: '', pendingText: '', pendingToolCalls: [] },
    streamingCompletedSteps: [],
  })
  vi.clearAllMocks()
})

describe('useAgentSessionStore.setProjectId', () => {
  it('clears session selection and detail state when switching projects', () => {
    useAgentSessionStore.setState({
      projectId: 'project-a',
      selectedSessionId: 'session-a',
      panelOpen: true,
      messages: [{ id: 'm1', sessionId: 'session-a', role: 'user', content: 'hello', createdAt: '' }],
      steps: [{ id: 's1', runId: 'r1', sessionId: 'session-a', stepIndex: 0, status: 'completed', createdAt: '', updatedAt: '' }],
    })

    useAgentSessionStore.getState().setProjectId('project-b')

    const state = useAgentSessionStore.getState()
    expect(state.projectId).toBe('project-b')
    expect(state.selectedSessionId).toBeNull()
    expect(state.panelOpen).toBe(false)
    expect(state.messages).toEqual([])
    expect(state.steps).toEqual([])
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({ projectId: 'project-b', limit: 200 })
  })

  it('is a no-op when projectId is unchanged', () => {
    useAgentSessionStore.setState({ projectId: 'project-a', selectedSessionId: 'session-a', panelOpen: true })

    useAgentSessionStore.getState().setProjectId('project-a')

    expect(useAgentSessionStore.getState().selectedSessionId).toBe('session-a')
    expect(useAgentSessionStore.getState().panelOpen).toBe(true)
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled()
  })
})

describe('useAgentSessionStore.submitSessionDraft', () => {
  it('creates a session with enriched prompt and wiki metadata', async () => {
    const session = await useAgentSessionStore.getState().submitSessionDraft('project-a', {
      message: 'Improve auth',
      prompt: '## User Goal\nImprove auth\n\n## Wiki Context\n- Document ID: doc_1',
      wikiAttachMode: 'auto',
      documentId: 'doc_1',
    })

    expect(agentRuntimeApi.createSession).toHaveBeenCalledWith({
      projectId: 'project-a',
      profileId: 'synax',
      prompt: '## User Goal\nImprove auth\n\n## Wiki Context\n- Document ID: doc_1',
      skillIds: undefined,
      permissionTier: undefined,
      sessionMetadata: {
        mode: 'goal',
        source: 'session-page',
        goalContent: 'Improve auth',
        wikiAttachMode: 'auto',
        documentId: 'doc_1',
      },
    })
    expect(session.id).toBe('ars_new')
    expect(useAgentSessionStore.getState().sessions[0]?.id).toBe('ars_new')
  })

  it('falls back to message when prompt is omitted', async () => {
    await useAgentSessionStore.getState().submitSessionDraft('project-a', {
      message: 'plain message',
    })

    expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'plain message',
        sessionMetadata: {
          mode: 'goal',
          source: 'session-page',
          goalContent: 'plain message',
        },
      }),
    )
  })
})
