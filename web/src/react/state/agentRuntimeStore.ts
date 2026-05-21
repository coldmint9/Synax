import { createStore, type StoreApi, useStore } from 'zustand'
import {
  agentRuntimeApi,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type EvidenceArtifact,
  type PermissionDecision,
  type RuntimeEvent,
  type StreamTurnRequest,
  type ToolCallRecord,
} from '../../lib/api/agentRuntime'

export interface AgentRuntimeState {
  projectId: string
  sessions: AgentSession[]
  activeSessionId: string | null
  messages: AgentRuntimeMessage[]
  events: RuntimeEvent[]
  artifacts: EvidenceArtifact[]
  permissions: PermissionDecision[]
  isStreaming: boolean
  error: string | null

  // Debug console
  runs: AgentRun[]
  steps: AgentRunStep[]
  debugPanelOpen: boolean
  debugSessionId: string | null

  refreshSessions: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  refreshSessionData: (sessionId?: string) => Promise<void>
  streamTurn: (sessionId: string, body: StreamTurnRequest) => Promise<void>
  clearError: () => void
  refreshRuns: (sessionId: string) => Promise<void>
  refreshSteps: (sessionId: string, runId: string) => Promise<void>
  openDebugPanel: (sessionId: string) => void
  closeDebugPanel: () => void
}

const stores = new Map<string, StoreApi<AgentRuntimeState>>()

function createAgentRuntimeStore(projectId: string): StoreApi<AgentRuntimeState> {
  return createStore<AgentRuntimeState>((set, get) => ({
    projectId,
    sessions: [],
    activeSessionId: null,
    messages: [],
    events: [],
    artifacts: [],
    permissions: [],
    isStreaming: false,
    error: null,
    runs: [],
    steps: [],
    debugPanelOpen: false,
    debugSessionId: null,

    clearError: () => set({ error: null }),

    openDebugPanel: (sessionId) => {
      set({ debugPanelOpen: true, debugSessionId: sessionId })
      void get().refreshRuns(sessionId)
    },

    closeDebugPanel: () => set({ debugPanelOpen: false, debugSessionId: null, runs: [], steps: [] }),

    refreshRuns: async (sessionId) => {
      try {
        const { items } = await agentRuntimeApi.listRuns(sessionId)
        set({ runs: items })
        const active = items.find(r => r.status === 'running') ?? items[items.length - 1]
        if (active) void get().refreshSteps(sessionId, active.id)
      } catch { /* silent */ }
    },

    refreshSteps: async (sessionId, runId) => {
      try {
        const { items } = await agentRuntimeApi.listRunSteps(sessionId, runId)
        set({ steps: items })
      } catch { /* silent */ }
    },

    refreshSessions: async () => {
      try {
        const { items } = await agentRuntimeApi.listSessions({ projectId })
        set({ sessions: items, error: null })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },

    selectSession: async (sessionId) => {
      set({ activeSessionId: sessionId })
      await get().refreshSessionData(sessionId)
    },

    refreshSessionData: async (sessionId = get().activeSessionId ?? undefined) => {
      if (!sessionId) return
      try {
        const [messages, events, artifacts, permissions] = await Promise.all([
          agentRuntimeApi.listMessages(sessionId),
          agentRuntimeApi.listEvents(sessionId),
          agentRuntimeApi.listArtifacts(sessionId),
          agentRuntimeApi.listPermissions(sessionId),
        ])
        set({
          messages: messages.items,
          events: events.items,
          artifacts: artifacts.items,
          permissions: permissions.items,
          error: null,
        })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },

    streamTurn: async (sessionId, body) => {
      set({ activeSessionId: sessionId, isStreaming: true, error: null })
      try {
        await agentRuntimeApi.streamTurn(sessionId, body, (chunk) => {
          if (!chunk || typeof chunk !== 'object') return
          const typed = chunk as { type?: string; message?: AgentRuntimeMessage; event?: RuntimeEvent }
          if (typed.message) {
            set((state) => ({ messages: [...state.messages, typed.message!] }))
          }
          if (typed.event) {
            set((state) => ({ events: [...state.events, typed.event!] }))
          }
        })
        await get().refreshSessionData(sessionId)
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ isStreaming: false })
      }
    },
  }))
}

export function getAgentRuntimeStore(projectId: string): StoreApi<AgentRuntimeState> {
  if (!stores.has(projectId)) {
    stores.set(projectId, createAgentRuntimeStore(projectId))
  }
  return stores.get(projectId)!
}

export function useAgentRuntimeState<T>(
  projectId: string,
  selector: (state: AgentRuntimeState) => T,
) {
  return useStore(getAgentRuntimeStore(projectId), selector)
}
