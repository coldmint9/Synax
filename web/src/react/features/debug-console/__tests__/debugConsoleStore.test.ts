import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime'
import { useDebugConsole } from '../debugConsoleStore'

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({ items: [], totalCount: 0, countByStatus: {} })),
  },
}))

afterEach(() => {
  useDebugConsole.setState({
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
    streamingStepId: null,
    streamingText: '',
    streamingThinking: '',
    streamingToolCalls: [],
    streamingCompletedSteps: [],
  })
  vi.clearAllMocks()
})

describe('useDebugConsole.setProjectId', () => {
  it('clears session selection and detail state when switching projects', () => {
    useDebugConsole.setState({
      projectId: 'project-a',
      selectedSessionId: 'session-a',
      panelOpen: true,
      messages: [{ id: 'm1', sessionId: 'session-a', role: 'user', content: 'hello', createdAt: '' }],
      steps: [{ id: 's1', runId: 'r1', sessionId: 'session-a', stepIndex: 0, status: 'completed', createdAt: '', updatedAt: '' }],
    })

    useDebugConsole.getState().setProjectId('project-b')

    const state = useDebugConsole.getState()
    expect(state.projectId).toBe('project-b')
    expect(state.selectedSessionId).toBeNull()
    expect(state.panelOpen).toBe(false)
    expect(state.messages).toEqual([])
    expect(state.steps).toEqual([])
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({ projectId: 'project-b' })
  })

  it('is a no-op when projectId is unchanged', () => {
    useDebugConsole.setState({ projectId: 'project-a', selectedSessionId: 'session-a', panelOpen: true })

    useDebugConsole.getState().setProjectId('project-a')

    expect(useDebugConsole.getState().selectedSessionId).toBe('session-a')
    expect(useDebugConsole.getState().panelOpen).toBe(true)
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled()
  })
})
