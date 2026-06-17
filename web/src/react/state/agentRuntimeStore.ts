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
import { useNotificationStore } from '../../react/state/notificationStore'

const CATEGORY_LABEL: Record<string, string> = {
  read: '读取',
  write: '写入',
  external_execution: '外部执行',
  high_risk: '高风险操作',
}

export interface CompactionEvent {
  stepId: string
  originalTokens: number
  compressedTokens: number
  messageCount: number
}

export interface AgentRuntimeState {
  projectId: string
  sessions: AgentSession[]
  activeSessionId: string | null
  messages: AgentRuntimeMessage[]
  events: RuntimeEvent[]
  artifacts: EvidenceArtifact[]
  permissions: PermissionDecision[]
  compactions: CompactionEvent[]
  isStreaming: boolean
  error: string | null

  // Run inspector (legacy agent loop test UI)
  runs: AgentRun[]
  steps: AgentRunStep[]
  runInspectorOpen: boolean
  runInspectorSessionId: string | null

  refreshSessions: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  refreshSessionData: (sessionId?: string) => Promise<void>
  streamTurn: (sessionId: string, body: StreamTurnRequest) => Promise<void>
  replyPermission: (permissionId: string, reply: 'once' | 'always' | 'reject') => Promise<void>
  resumeAfterPermission: () => Promise<void>
  clearError: () => void
  refreshRuns: (sessionId: string) => Promise<void>
  refreshSteps: (sessionId: string, runId: string) => Promise<void>
  openRunInspector: (sessionId: string) => void
  closeRunInspector: () => void
}

const stores = new Map<string, StoreApi<AgentRuntimeState>>()

function handleStreamChunk(
  chunk: unknown,
  set: StoreApi<AgentRuntimeState>['setState'],
  get: StoreApi<AgentRuntimeState>['getState'],
) {
  if (!chunk || typeof chunk !== 'object') return
  const typed = chunk as {
    type?: string
    message?: AgentRuntimeMessage
    event?: RuntimeEvent
    permission?: PermissionDecision
  }
  if (typed.message) {
    set((s) => ({ messages: [...s.messages, typed.message!] }))
  }
  if (typed.event) {
    set((s) => ({ events: [...s.events, typed.event!] }))
  }
  if (typed.type === 'permission_requested' && typed.permission) {
    const perm = typed.permission
    set((s) => ({ permissions: [...s.permissions, perm] }))
    const label = CATEGORY_LABEL[perm.coarseCategory] ?? perm.coarseCategory
    const replyFn = get().replyPermission
    useNotificationStore.getState().push({
      id: `perm-${perm.id}`,
      type: 'warning',
      message: `Agent 请求${label}: ${perm.patterns[0] ?? ''}`,
      duration: 0,
      actions: [
        { label: '允许', variant: 'primary', onClick: () => void replyFn(perm.id, 'once') },
        { label: '拒绝', variant: 'danger', onClick: () => void replyFn(perm.id, 'reject') },
      ],
    })
  }
  if (typed.type === 'context_compacted') {
    const c = chunk as { stepId?: string; originalTokens?: number; compressedTokens?: number; messageCount?: number }
    if (c.originalTokens != null && c.compressedTokens != null) {
      set((s) => ({
        compactions: [...s.compactions, {
          stepId: c.stepId ?? '',
          originalTokens: c.originalTokens!,
          compressedTokens: c.compressedTokens!,
          messageCount: c.messageCount ?? 0,
        }],
      }))
    }
  }
}

function createAgentRuntimeStore(projectId: string): StoreApi<AgentRuntimeState> {
  return createStore<AgentRuntimeState>((set, get) => ({
    projectId,
    sessions: [],
    activeSessionId: null,
    messages: [],
    events: [],
    artifacts: [],
    permissions: [],
    compactions: [],
    isStreaming: false,
    error: null,
    runs: [],
    steps: [],
    runInspectorOpen: false,
    runInspectorSessionId: null,

    clearError: () => set({ error: null }),

    openRunInspector: (sessionId) => {
      set({ runInspectorOpen: true, runInspectorSessionId: sessionId })
      void get().refreshRuns(sessionId)
    },

    closeRunInspector: () => set({ runInspectorOpen: false, runInspectorSessionId: null, runs: [], steps: [] }),

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
          handleStreamChunk(chunk, set, get)
        })
        await get().refreshSessionData(sessionId)
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ isStreaming: false })
      }
    },

    replyPermission: async (permissionId, reply) => {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      try {
        const updated = await agentRuntimeApi.replyPermission(sessionId, permissionId, reply)
        set((s) => ({
          permissions: s.permissions.map(p => p.id === permissionId ? updated : p),
        }))
        useNotificationStore.getState().dismiss(`perm-${permissionId}`)
        if (reply !== 'reject') {
          void get().resumeAfterPermission()
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },

    resumeAfterPermission: async () => {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      set({ isStreaming: true })
      try {
        await agentRuntimeApi.resumeStream(sessionId, {}, (chunk) => {
          handleStreamChunk(chunk, set, get)
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
