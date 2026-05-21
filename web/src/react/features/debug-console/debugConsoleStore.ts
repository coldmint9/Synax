import { create } from 'zustand'
import {
  agentRuntimeApi,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type RuntimeEvent,
  type SessionStats,
  type TodoItem,
  type ToolCallRecord,
} from '../../../lib/api/agentRuntime'
import type { SessionLiveEvent } from '../../../lib/api/sessionLive'

export interface DebugConsoleState {
  sessions: AgentSession[]
  selectedSessionId: string | null
  panelOpen: boolean
  runs: AgentRun[]
  steps: AgentRunStep[]
  events: RuntimeEvent[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]
  childSessions: Record<string, AgentSession[]>
  sessionStats: SessionStats | null
  sessionTodos: TodoItem[]

  // 流式进行中状态
  streamingStepId: string | null
  streamingText: string
  streamingThinking: string
  streamingToolCalls: ToolCallRecord[]

  refreshSessions: () => Promise<void>
  deleteSession: (sessionId: string) => Promise<string[]>
  openPanel: (sessionId: string) => void
  closePanel: () => void
  refreshDetail: () => Promise<void>
  fetchChildSessions: (parentId: string) => Promise<void>
  pauseSession: (sessionId: string) => Promise<void>
  resumeSession: (sessionId: string, message?: string) => Promise<void>
  fetchSessionStats: () => Promise<void>
  fetchSessionTodos: () => Promise<void>
  applyLiveEvent: (event: SessionLiveEvent) => void
}

export const useDebugConsole = create<DebugConsoleState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  panelOpen: false,
  runs: [],
  steps: [],
  events: [],
  messages: [],
  toolCalls: [],
  childSessions: {},
  sessionStats: null,
  sessionTodos: [],
  streamingStepId: null,
  streamingText: '',
  streamingThinking: '',
  streamingToolCalls: [],

  refreshSessions: async () => {
    try {
      const { items } = await agentRuntimeApi.listSessions()
      set({ sessions: items })
    } catch { /* API not available */ }
  },

  deleteSession: async (sessionId) => {
    const { deletedSessionIds } = await agentRuntimeApi.deleteSession(sessionId)
    const deleted = new Set(deletedSessionIds)
    const shouldClosePanel = Boolean(get().selectedSessionId && deleted.has(get().selectedSessionId!))
    set({
      sessions: get().sessions.filter((session) => !deleted.has(session.id)),
      selectedSessionId: shouldClosePanel ? null : get().selectedSessionId,
      panelOpen: shouldClosePanel ? false : get().panelOpen,
      runs: shouldClosePanel ? [] : get().runs,
      steps: shouldClosePanel ? [] : get().steps,
      events: shouldClosePanel ? [] : get().events,
      messages: shouldClosePanel ? [] : get().messages,
      toolCalls: shouldClosePanel ? [] : get().toolCalls,
    })
    return deletedSessionIds
  },

  openPanel: (sessionId) => {
    set({ panelOpen: true, selectedSessionId: sessionId, runs: [], steps: [], events: [], messages: [], toolCalls: [] })
    void get().refreshDetail()
  },

  closePanel: () => set({ panelOpen: false }),

  refreshDetail: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const [runsRes, eventsRes, messagesRes, toolCallsRes] = await Promise.all([
        agentRuntimeApi.listRuns(selectedSessionId),
        agentRuntimeApi.listEvents(selectedSessionId),
        agentRuntimeApi.listMessages(selectedSessionId),
        agentRuntimeApi.listToolCalls(selectedSessionId),
      ])
      set({
        runs: runsRes.items,
        events: eventsRes.items,
        messages: messagesRes.items,
        toolCalls: toolCallsRes.items,
        streamingStepId: null,
        streamingText: '',
        streamingThinking: '',
        streamingToolCalls: [],
      })
      const activeRun = runsRes.items.find(r => r.status === 'running') ?? runsRes.items[runsRes.items.length - 1]
      if (activeRun) {
        const stepsRes = await agentRuntimeApi.listRunSteps(selectedSessionId, activeRun.id)
        set({ steps: stepsRes.items })
      }
      // Fetch child sessions if any
      const session = get().sessions.find(s => s.id === selectedSessionId)
      if (session && session.childSessionIds.length > 0) {
        void get().fetchChildSessions(selectedSessionId)
      }
      // Fetch stats and todos in parallel
      void get().fetchSessionStats()
      void get().fetchSessionTodos()
    } catch { /* silent */ }
  },

  fetchChildSessions: async (parentId) => {
    try {
      const { items } = await agentRuntimeApi.listSessions()
      const children = items.filter(s => s.parentSessionId === parentId)
      set({ childSessions: { ...get().childSessions, [parentId]: children } })
    } catch { /* silent */ }
  },

  pauseSession: async (sessionId) => {
    try {
      await agentRuntimeApi.pauseSession(sessionId)
      void get().refreshSessions()
      void get().refreshDetail()
    } catch { /* silent */ }
  },

  resumeSession: async (sessionId, message) => {
    set({
      sessions: get().sessions.map(s =>
        s.id === sessionId ? { ...s, status: 'running' as const } : s,
      ),
    })
    agentRuntimeApi.resumeStream(sessionId, message ? { message } : {}, (chunk) => {
      const c = chunk as { type?: string; error?: string }
      if (c.type === 'error') {
        console.error('[resume] backend error:', c.error)
        void get().refreshSessions()
        void get().refreshDetail()
      }
    }).then(() => {
      void get().refreshSessions()
      void get().refreshDetail()
    }).catch((err) => {
      console.error('[resume] stream failed:', err)
      void get().refreshSessions()
      void get().refreshDetail()
    })
  },

  fetchSessionStats: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const stats = await agentRuntimeApi.getSessionStats(selectedSessionId)
      set({ sessionStats: stats })
    } catch { /* silent */ }
  },

  fetchSessionTodos: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const { items } = await agentRuntimeApi.getSessionTodos(selectedSessionId)
      set({ sessionTodos: items })
    } catch { /* silent */ }
  },

  applyLiveEvent: (event) => {
    switch (event.type) {
      case 'step_started':
        set({ streamingStepId: event.stepId, streamingText: '', streamingThinking: '', streamingToolCalls: [] })
        break
      case 'message_delta':
        set(s => ({ streamingText: s.streamingText + event.delta }))
        break
      case 'thought_delta':
        set(s => ({ streamingThinking: s.streamingThinking + event.delta }))
        break
      case 'tool_call':
        set(s => ({ streamingToolCalls: [...s.streamingToolCalls, event.toolCall] }))
        break
      case 'tool_result':
        set(s => ({
          streamingToolCalls: s.streamingToolCalls.map(tc =>
            tc.id === event.toolCall.id ? event.toolCall : tc,
          ),
        }))
        break
    }
  },
}))
