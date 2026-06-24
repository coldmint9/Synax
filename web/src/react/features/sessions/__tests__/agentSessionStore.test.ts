import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore } from '../agentSessionStore'

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({ items: [], totalCount: 0, countByStatus: {} })),
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
