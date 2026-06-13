import { create } from 'zustand'
import {
  agentRuntimeApi,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type PermissionDecision,
  type RuntimeEvent,
  type SessionStats,
  type SessionCapabilities,
  type TodoItem,
  type ToolCallRecord,
} from '../../../lib/api/agentRuntime'
import type { SessionLiveEvent } from '../../../lib/api/sessionLive'
import { ensureSessionLiveSubscription, releaseSessionLiveSubscription } from '../../../lib/api/sessionLiveClient'
import { AppError } from '../../../lib/errors'
import { useNotificationStore } from '../../state/notificationStore'

function ensureLiveStream(sessionId: string): void {
  ensureSessionLiveSubscription(sessionId, (event) => {
    useDebugConsole.getState().applyLiveEvent(event)
  })
}

// --- Delta backpressure: drain buffered text at a controlled rate per frame ---
let _textBuffer = ''
let _thinkingBuffer = ''
let _rafId: number | null = null
let _intervalId: ReturnType<typeof setInterval> | null = null

const CHARS_PER_FRAME_BASE = 80
const CHARS_PER_FRAME_MAX = 600
const BACKPRESSURE_THRESHOLD = 150

function _computeChunkSize(bufferLen: number): number {
  if (bufferLen > BACKPRESSURE_THRESHOLD) {
    return Math.min(CHARS_PER_FRAME_MAX, Math.ceil(bufferLen / 3))
  }
  if (bufferLen > 60) {
    return Math.min(CHARS_PER_FRAME_MAX, Math.ceil(bufferLen / 2))
  }
  return CHARS_PER_FRAME_BASE
}

function _drainLoop() {
  _rafId = null
  const textLen = _textBuffer.length
  const thinkLen = _thinkingBuffer.length
  if (textLen === 0 && thinkLen === 0) return

  // Text and thinking each get their own independent quota per frame
  const textChunk = _computeChunkSize(textLen)
  const thinkChunk = _computeChunkSize(thinkLen)

  let t = ''
  let th = ''
  if (textLen > 0) {
    t = _textBuffer.slice(0, Math.min(textLen, textChunk))
    _textBuffer = _textBuffer.slice(t.length)
  }
  if (thinkLen > 0) {
    th = _thinkingBuffer.slice(0, Math.min(thinkLen, thinkChunk))
    _thinkingBuffer = _thinkingBuffer.slice(th.length)
  }

  if (t || th) {
    useDebugConsole.setState(s => ({
      ...(t ? { streamingText: s.streamingText + t } : {}),
      ...(th ? { streamingThinking: s.streamingThinking + th } : {}),
    }))
  }

  if (_textBuffer.length > 0 || _thinkingBuffer.length > 0) {
    _rafId = requestAnimationFrame(_drainLoop)
  } else if (_intervalId !== null) {
    clearInterval(_intervalId)
    _intervalId = null
  }
}

function _scheduleFlush() {
  if (_rafId !== null) return
  _rafId = requestAnimationFrame(_drainLoop)
}

// Keep draining even when tab is hidden (rAF pauses in background)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Switch to setInterval when tab is hidden
      if (_intervalId === null && (_textBuffer.length > 0 || _thinkingBuffer.length > 0)) {
        _intervalId = setInterval(_drainLoop, 32)
      }
    } else {
      // Switch back to rAF when tab is visible
      if (_intervalId !== null) {
        clearInterval(_intervalId)
        _intervalId = null
      }
      if (_rafId === null && (_textBuffer.length > 0 || _thinkingBuffer.length > 0)) {
        _rafId = requestAnimationFrame(_drainLoop)
      }
    }
  })
}

export interface DebugConsoleState {
  projectId: string | null
  sessions: AgentSession[]
  selectedSessionId: string | null
  panelOpen: boolean
  runs: AgentRun[]
  steps: AgentRunStep[]
  events: RuntimeEvent[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]
  childSessions: Record<string, AgentSession[]>
  permissions: PermissionDecision[]
  sessionStats: SessionStats | null
  sessionTodos: TodoItem[]
  sessionCapabilities: SessionCapabilities | null

  // 流式进行中状态
  streamingStepId: string | null
  streamingText: string
  streamingThinking: string
  streamingToolCalls: ToolCallRecord[]
  streamingCompletedSteps: Array<{
    stepId: string
    stepIndex: number
    text: string
    thinking: string
    toolCalls: ToolCallRecord[]
  }>

  setProjectId: (projectId: string | null) => void
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
  fetchSessionCapabilities: () => Promise<void>
  replyPermission: (permissionId: string, reply: 'once' | 'always' | 'reject') => Promise<void>
  applyLiveEvent: (event: SessionLiveEvent) => void
}

type SessionDetailState = Pick<
  DebugConsoleState,
  | 'selectedSessionId'
  | 'panelOpen'
  | 'runs'
  | 'steps'
  | 'events'
  | 'messages'
  | 'toolCalls'
  | 'childSessions'
  | 'permissions'
  | 'sessionStats'
  | 'sessionTodos'
  | 'sessionCapabilities'
  | 'streamingStepId'
  | 'streamingText'
  | 'streamingThinking'
  | 'streamingToolCalls'
  | 'streamingCompletedSteps'
>

function emptySessionDetailState(): SessionDetailState {
  return {
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
    streamingStepId: null,
    streamingText: '',
    streamingThinking: '',
    streamingToolCalls: [],
    streamingCompletedSteps: [],
  }
}

function clearStreamingBuffers(): void {
  _textBuffer = ''
  _thinkingBuffer = ''
}

export const useDebugConsole = create<DebugConsoleState>((set, get) => ({
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
  streamingStepId: null,
  streamingText: '',
  streamingThinking: '',
  streamingToolCalls: [],
  streamingCompletedSteps: [],

  setProjectId: (projectId) => {
    if (projectId === get().projectId) return
    releaseSessionLiveSubscription()
    clearStreamingBuffers()
    set({ projectId, sessions: [], ...emptySessionDetailState() })
    void get().refreshSessions()
  },

  refreshSessions: async () => {
    const { projectId } = get()
    try {
      const query = projectId ? { projectId } : {}
      const { items } = await agentRuntimeApi.listSessions(query)
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
    const prev = get().selectedSessionId
    set({
      panelOpen: true,
      selectedSessionId: sessionId,
      streamingStepId: null,
      streamingText: '',
      streamingThinking: '',
      streamingToolCalls: [],
      streamingCompletedSteps: [],
    })
    // Only clear persisted data if switching to a different session
    // refreshDetail will atomically replace with new data
    if (prev !== sessionId) {
      clearStreamingBuffers()
    }
    ensureLiveStream(sessionId)
    void get().refreshDetail()
  },

  closePanel: () => {
    releaseSessionLiveSubscription()
    set({ panelOpen: false })
  },

  refreshDetail: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    const targetSessionId = selectedSessionId
    try {
      const [runsRes, eventsRes, messagesRes, toolCallsRes, permissionsRes] = await Promise.all([
        agentRuntimeApi.listRuns(targetSessionId),
        agentRuntimeApi.listEvents(targetSessionId),
        agentRuntimeApi.listMessages(targetSessionId),
        agentRuntimeApi.listToolCalls(targetSessionId),
        agentRuntimeApi.listPermissions(targetSessionId),
      ])
      // Guard: if session changed during fetch, discard stale results
      if (get().selectedSessionId !== targetSessionId) return
      // While the session is still running, deltas are actively accumulating in
      // streamingText/Thinking/ToolCalls (fed by the live EventSource). A bulk
      // refresh must NOT wipe that in-flight state, or the live block resets to
      // empty on every step-completion poll and the stream looks frozen until the
      // whole step lands in the DB. Only clear streaming state once settled.
      const sessionStillRunning =
        get().sessions.find(s => s.id === targetSessionId)?.status === 'running'
      set({
        runs: runsRes.items,
        events: eventsRes.items,
        messages: messagesRes.items,
        toolCalls: toolCallsRes.items,
        permissions: permissionsRes.items,
        ...(sessionStillRunning ? {} : {
          streamingStepId: null,
          streamingText: '',
          streamingThinking: '',
          streamingToolCalls: [],
          streamingCompletedSteps: [],
        }),
      })
      // Load all steps for this session in a single request
      const stepsRes = await agentRuntimeApi.listSessionSteps(targetSessionId)
      if (get().selectedSessionId !== targetSessionId) return
      set({ steps: stepsRes.items })
      // Fetch child sessions if any
      const session = get().sessions.find(s => s.id === selectedSessionId)
      if (session && session.childSessionIds.length > 0) {
        void get().fetchChildSessions(selectedSessionId)
      }
      // Fetch stats and todos in parallel
      void get().fetchSessionStats()
      void get().fetchSessionTodos()
      void get().fetchSessionCapabilities()
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
    ensureLiveStream(sessionId)
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
      if (err instanceof AppError && err.code === 'SESSION_BUSY') {
        useNotificationStore.getState().push({
          type: 'warning',
          message: 'This session already has an active run.',
        })
      } else {
        console.error('[resume] stream failed:', err)
      }
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

  fetchSessionCapabilities: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const capabilities = await agentRuntimeApi.getSessionCapabilities(selectedSessionId)
      set({ sessionCapabilities: capabilities })
    } catch { /* silent */ }
  },

  replyPermission: async (permissionId, reply) => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const updated = await agentRuntimeApi.replyPermission(selectedSessionId, permissionId, reply)
      set(s => ({
        permissions: s.permissions.map(p => p.id === permissionId ? updated : p),
      }))
      useNotificationStore.getState().dismiss(`perm-${permissionId}`)
      if (reply !== 'reject') {
        void get().refreshDetail()
      }
    } catch { /* silent */ }
  },

  applyLiveEvent: (event) => {
    switch (event.type) {
      case 'step_started': {
        const s = get()
        const hasContent = s.streamingStepId && (s.streamingText || s.streamingThinking || s.streamingToolCalls.length > 0)
        const completedSteps = hasContent
          ? [...s.streamingCompletedSteps, {
              stepId: s.streamingStepId!,
              stepIndex: s.streamingCompletedSteps.length + 1,
              text: s.streamingText,
              thinking: s.streamingThinking,
              toolCalls: s.streamingToolCalls,
            }]
          : s.streamingCompletedSteps
        _textBuffer = ''
        _thinkingBuffer = ''
        set({
          streamingStepId: event.stepId,
          streamingText: '',
          streamingThinking: '',
          streamingToolCalls: [],
          streamingCompletedSteps: completedSteps,
        })
        break
      }
      case 'message_delta':
        _textBuffer += event.delta
        _scheduleFlush()
        break
      case 'thought_delta':
        _thinkingBuffer += event.delta
        _scheduleFlush()
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
        void get().fetchSessionCapabilities()
        break
    }
  },
}))
