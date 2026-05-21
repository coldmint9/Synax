import { create } from 'zustand'
import {
  agentRuntimeApi,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type RuntimeEvent,
  type ToolCallRecord,
} from '../../../lib/api/agentRuntime'

export interface DebugConsoleState {
  sessions: AgentSession[]
  selectedSessionId: string | null
  panelOpen: boolean
  runs: AgentRun[]
  steps: AgentRunStep[]
  events: RuntimeEvent[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]

  refreshSessions: () => Promise<void>
  deleteSession: (sessionId: string) => Promise<string[]>
  openPanel: (sessionId: string) => void
  closePanel: () => void
  refreshDetail: () => Promise<void>
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
      set({ runs: runsRes.items, events: eventsRes.items, messages: messagesRes.items, toolCalls: toolCallsRes.items })
      const activeRun = runsRes.items.find(r => r.status === 'running') ?? runsRes.items[runsRes.items.length - 1]
      if (activeRun) {
        const stepsRes = await agentRuntimeApi.listRunSteps(selectedSessionId, activeRun.id)
        set({ steps: stepsRes.items })
      }
    } catch { /* silent */ }
  },
}))
