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
import { SYNAX_PROFILE_ID, createSynaxSessionMetadata } from '../wiki/goal/goalAttachTypes'
import { useNotificationStore } from '../../state/notificationStore'
import { patchAgentSession } from './sessionComposerState'

const READ_MARKERS_KEY = 'synax-session-read-markers'

function readMarkersStorageKey(projectId: string): string {
  return `${READ_MARKERS_KEY}:${projectId}`
}

function loadReadMarkers(projectId: string | null): Record<string, string> {
  if (!projectId || typeof localStorage === 'undefined') return {}
  const key = readMarkersStorageKey(projectId)
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as Record<string, string>
    if (typeof sessionStorage !== 'undefined') {
      const legacy = sessionStorage.getItem(`${READ_MARKERS_KEY}:${projectId}`)
      if (legacy) {
        localStorage.setItem(key, legacy)
        sessionStorage.removeItem(`${READ_MARKERS_KEY}:${projectId}`)
        return JSON.parse(legacy) as Record<string, string>
      }
    }
  } catch {
    return {}
  }
  return {}
}

function saveReadMarkers(projectId: string | null, markers: Record<string, string>): void {
  if (!projectId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(readMarkersStorageKey(projectId), JSON.stringify(markers))
  } catch { /* quota */ }
}

/** Sessions that no longer need attention unless explicitly updated after read. */
const ATTENTION_SESSION_STATUSES = new Set<AgentSession['status']>([
  'running',
  'waiting_permission',
  'queued',
])

export function isSessionUnread(
  session: AgentSession,
  readMarkers: Record<string, string>,
): boolean {
  const readUpdatedAt = readMarkers[session.id]
  if (!readUpdatedAt) {
    return ATTENTION_SESSION_STATUSES.has(session.status)
  }
  return new Date(session.updatedAt).getTime() > new Date(readUpdatedAt).getTime()
}

const SESSION_DETAIL_CACHE_LIMIT = 16
const SESSION_DETAIL_CACHE_TTL_MS = 45_000

export interface SessionDetailCacheEntry {
  runs: AgentRun[]
  steps: AgentRunStep[]
  events: RuntimeEvent[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]
  permissions: PermissionDecision[]
  sessionStats: SessionStats | null
  sessionTodos: TodoItem[]
  sessionCapabilities: SessionCapabilities | null
  cachedAt: number
}

let activeDetailRefresh: { sessionId: string; promise: Promise<void> } | null = null

function trimSessionDetailCache(
  cache: Record<string, SessionDetailCacheEntry>,
): Record<string, SessionDetailCacheEntry> {
  const keys = Object.keys(cache)
  if (keys.length <= SESSION_DETAIL_CACHE_LIMIT) return cache
  const drop = keys
    .sort((a, b) => cache[a].cachedAt - cache[b].cachedAt)
    .slice(0, keys.length - SESSION_DETAIL_CACHE_LIMIT)
  const next = { ...cache }
  for (const key of drop) delete next[key]
  return next
}

function emptyDetailPayload(): Pick<
  AgentSessionStoreState,
  'runs' | 'steps' | 'events' | 'messages' | 'toolCalls' | 'permissions'
  | 'sessionStats' | 'sessionTodos' | 'sessionCapabilities'
> {
  return {
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionCapabilities: null,
  }
}

function isActiveSessionStatus(status: AgentSession['status'] | undefined): boolean {
  return status === 'running' || status === 'waiting_permission'
}

type AgentRunStreamChunk = {
  type?: string
  run?: { id: string; status?: string }
  runId?: string
  sessionId?: string
}

function applySessionStreamChunk(sessionId: string, chunk: unknown): Partial<AgentSession> | null {
  if (!chunk || typeof chunk !== 'object') return null
  const typed = chunk as AgentRunStreamChunk
  switch (typed.type) {
    case 'run_started':
    case 'run_resumed':
      return typed.run
        ? { status: 'running', activeRunId: typed.run.id, blockedReason: null }
        : { status: 'running' }
    case 'permission_requested':
      return typed.runId
        ? { status: 'waiting_permission', activeRunId: typed.runId }
        : { status: 'waiting_permission' }
    case 'run_completed':
      return { status: 'completed', activeRunId: null, pendingResumeToken: null, blockedReason: null }
    case 'run_failed':
      return { status: 'failed', activeRunId: null, pendingResumeToken: null }
    case 'done': {
      const current = useAgentSessionStore.getState().sessions.find(s => s.id === sessionId)
      if (current?.status === 'waiting_permission') {
        return { activeRunId: null }
      }
      return { status: 'completed', activeRunId: null, pendingResumeToken: null, blockedReason: null }
    }
    default:
      return null
  }
}

function onSessionStreamChunk(sessionId: string, chunk: unknown): void {
  const patch = applySessionStreamChunk(sessionId, chunk)
  if (patch) {
    useAgentSessionStore.getState().patchSession(sessionId, patch)
  }
}

function patchSessionDetailCache(
  sessionId: string,
  patch: Partial<SessionDetailCacheEntry>,
): void {
  const existing = useAgentSessionStore.getState().sessionDetailCache[sessionId]
  if (!existing) return
  useAgentSessionStore.setState(s => ({
    sessionDetailCache: trimSessionDetailCache({
      ...s.sessionDetailCache,
      [sessionId]: { ...existing, ...patch, cachedAt: Date.now() },
    }),
  }))
}

function ensureLiveStream(sessionId: string): void {
  ensureSessionLiveSubscription(sessionId, (event) => {
    useAgentSessionStore.getState().applyLiveEvent(event)
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
    useAgentSessionStore.setState(s => ({
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

export interface AgentSessionStoreState {
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
  readSessionMarkers: Record<string, string>
  sessionDetailCache: Record<string, SessionDetailCacheEntry>

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
  resetSessionDetailForDraft: () => void
  submitGoalDraft: (projectId: string, body: { message: string; model?: string | null }) => Promise<AgentSession>
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
  sendSessionMessage: (sessionId: string, body: { message: string; model?: string | null }) => Promise<void>
  cancelSessionRun: (sessionId: string) => Promise<void>
  applyLiveEvent: (event: SessionLiveEvent) => void
  patchSession: (sessionId: string, patch: Partial<AgentSession>) => void
  markSessionRead: (sessionId: string) => void
}

type SessionDetailState = Pick<
  AgentSessionStoreState,
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

export const useAgentSessionStore = create<AgentSessionStoreState>((set, get) => ({
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
  streamingText: '',
  streamingThinking: '',
  streamingToolCalls: [],
  streamingCompletedSteps: [],

  setProjectId: (projectId) => {
    if (projectId === get().projectId) return
    releaseSessionLiveSubscription()
    clearStreamingBuffers()
    set({
      projectId,
      sessions: [],
      readSessionMarkers: loadReadMarkers(projectId),
      sessionDetailCache: {},
      ...emptySessionDetailState(),
    })
    void get().refreshSessions()
  },

  refreshSessions: async () => {
    const { projectId } = get()
    if (!projectId) return
    try {
      const { items } = await agentRuntimeApi.listSessions({ projectId, limit: 200 })
      set({ sessions: items })
    } catch { /* API not available */ }
  },

  resetSessionDetailForDraft: () => {
    releaseSessionLiveSubscription()
    clearStreamingBuffers()
    set({
      panelOpen: false,
      selectedSessionId: null,
      runs: [],
      steps: [],
      events: [],
      messages: [],
      toolCalls: [],
      permissions: [],
      sessionStats: null,
      sessionTodos: [],
      sessionCapabilities: null,
      streamingStepId: null,
      streamingText: '',
      streamingThinking: '',
      streamingToolCalls: [],
      streamingCompletedSteps: [],
    })
  },

  submitGoalDraft: async (projectId, body) => {
    const message = body.message.trim()
    if (!message) {
      throw new AppError('Goal message is required.', { level: 'business', code: 'VALIDATION' })
    }
    const payload = await agentRuntimeApi.createSession({
      projectId,
      profileId: SYNAX_PROFILE_ID,
      prompt: message,
      sessionMetadata: createSynaxSessionMetadata('goal', {
        source: 'session-page',
        goalContent: message,
      }),
    })
    set(s => ({
      sessions: [payload.session, ...s.sessions.filter(item => item.id !== payload.session.id)],
    }))
    void get().refreshSessions()
    return payload.session
  },

  deleteSession: async (sessionId) => {
    const { deletedSessionIds } = await agentRuntimeApi.deleteSession(sessionId)
    const deleted = new Set(deletedSessionIds)
    const shouldClosePanel = Boolean(get().selectedSessionId && deleted.has(get().selectedSessionId!))
    const nextCache = { ...get().sessionDetailCache }
    for (const id of deleted) delete nextCache[id]
    set({
      sessions: get().sessions.filter((session) => !deleted.has(session.id)),
      sessionDetailCache: nextCache,
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
    const isSwitch = prev !== sessionId
    get().markSessionRead(sessionId)
    const session = get().sessions.find(s => s.id === sessionId)
    const cached = isSwitch ? get().sessionDetailCache[sessionId] : null
    const cacheFresh = Boolean(cached && Date.now() - cached.cachedAt < SESSION_DETAIL_CACHE_TTL_MS)

    set({
      panelOpen: true,
      selectedSessionId: sessionId,
      streamingStepId: null,
      streamingText: '',
      streamingThinking: '',
      streamingToolCalls: [],
      streamingCompletedSteps: [],
      ...(cached
        ? {
            runs: cached.runs,
            steps: cached.steps,
            events: cached.events,
            messages: cached.messages,
            toolCalls: cached.toolCalls,
            permissions: cached.permissions,
            sessionStats: cached.sessionStats,
            sessionTodos: cached.sessionTodos,
            sessionCapabilities: cached.sessionCapabilities,
          }
        : isSwitch
          ? emptyDetailPayload()
          : {}),
    })
    if (isSwitch) clearStreamingBuffers()
    ensureLiveStream(sessionId)

    const needsRefresh = !cached || isActiveSessionStatus(session?.status) || !cacheFresh
    if (needsRefresh) void get().refreshDetail()
  },

  closePanel: () => {
    releaseSessionLiveSubscription()
    set({ panelOpen: false })
  },

  refreshDetail: async () => {
    const targetSessionId = get().selectedSessionId
    if (!targetSessionId) return

    if (activeDetailRefresh?.sessionId === targetSessionId) {
      return activeDetailRefresh.promise
    }

    const promise = (async () => {
      try {
        const [
          runsRes,
          eventsRes,
          messagesRes,
          toolCallsRes,
          permissionsRes,
          stepsRes,
          stats,
          todosRes,
          capabilities,
        ] = await Promise.all([
          agentRuntimeApi.listRuns(targetSessionId),
          agentRuntimeApi.listEvents(targetSessionId),
          agentRuntimeApi.listMessages(targetSessionId),
          agentRuntimeApi.listToolCalls(targetSessionId),
          agentRuntimeApi.listPermissions(targetSessionId),
          agentRuntimeApi.listSessionSteps(targetSessionId),
          agentRuntimeApi.getSessionStats(targetSessionId).catch(() => null),
          agentRuntimeApi.getSessionTodos(targetSessionId).catch(() => ({ items: [] as TodoItem[] })),
          agentRuntimeApi.getSessionCapabilities(targetSessionId).catch(() => null),
        ])
        if (get().selectedSessionId !== targetSessionId) return

        const sessionStillRunning =
          get().sessions.find(s => s.id === targetSessionId)?.status === 'running'
        const cacheEntry: SessionDetailCacheEntry = {
          runs: runsRes.items,
          steps: stepsRes.items,
          events: eventsRes.items,
          messages: messagesRes.items,
          toolCalls: toolCallsRes.items,
          permissions: permissionsRes.items,
          sessionStats: stats,
          sessionTodos: todosRes.items,
          sessionCapabilities: capabilities,
          cachedAt: Date.now(),
        }

        set(s => ({
          runs: cacheEntry.runs,
          events: cacheEntry.events,
          messages: cacheEntry.messages,
          toolCalls: cacheEntry.toolCalls,
          permissions: cacheEntry.permissions,
          steps: cacheEntry.steps,
          sessionStats: cacheEntry.sessionStats,
          sessionTodos: cacheEntry.sessionTodos,
          sessionCapabilities: cacheEntry.sessionCapabilities,
          sessionDetailCache: trimSessionDetailCache({
            ...s.sessionDetailCache,
            [targetSessionId]: cacheEntry,
          }),
          ...(sessionStillRunning ? {} : {
            streamingStepId: null,
            streamingText: '',
            streamingThinking: '',
            streamingToolCalls: [],
            streamingCompletedSteps: [],
          }),
        }))

        const session = get().sessions.find(s => s.id === targetSessionId)
        if (session && session.childSessionIds.length > 0) {
          void get().fetchChildSessions(targetSessionId)
        }
      } catch { /* silent */ }
    })()

    activeDetailRefresh = { sessionId: targetSessionId, promise }
    try {
      await promise
    } finally {
      if (activeDetailRefresh?.sessionId === targetSessionId) {
        activeDetailRefresh = null
      }
    }
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
      onSessionStreamChunk(sessionId, chunk)
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
      if (get().selectedSessionId !== selectedSessionId) return
      set({ sessionStats: stats })
      patchSessionDetailCache(selectedSessionId, { sessionStats: stats })
    } catch { /* silent */ }
  },

  fetchSessionTodos: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const { items } = await agentRuntimeApi.getSessionTodos(selectedSessionId)
      if (get().selectedSessionId !== selectedSessionId) return
      set({ sessionTodos: items })
      patchSessionDetailCache(selectedSessionId, { sessionTodos: items })
    } catch { /* silent */ }
  },

  fetchSessionCapabilities: async () => {
    const { selectedSessionId } = get()
    if (!selectedSessionId) return
    try {
      const capabilities = await agentRuntimeApi.getSessionCapabilities(selectedSessionId)
      if (get().selectedSessionId !== selectedSessionId) return
      set({ sessionCapabilities: capabilities })
      patchSessionDetailCache(selectedSessionId, { sessionCapabilities: capabilities })
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

  sendSessionMessage: async (sessionId, body) => {
    ensureLiveStream(sessionId)
    const session = get().sessions.find(s => s.id === sessionId)
    const shouldResume = session
      && ['interrupted', 'paused', 'cancelled', 'failed', 'blocked', 'completed'].includes(session.status)

    set(s => ({
      sessions: s.sessions.map(sess =>
        sess.id === sessionId ? { ...sess, status: 'running' as const } : sess,
      ),
    }))
    try {
      if (shouldResume) {
        await agentRuntimeApi.resumeStream(sessionId, body, (chunk) => {
          onSessionStreamChunk(sessionId, chunk)
        })
      } else {
        await agentRuntimeApi.streamTurn(sessionId, body, (chunk) => {
          onSessionStreamChunk(sessionId, chunk)
        })
      }
    } finally {
      void get().refreshSessions()
      void get().refreshDetail()
    }
  },

  cancelSessionRun: async (sessionId) => {
    try {
      await agentRuntimeApi.cancelSession(sessionId)
    } finally {
      void get().refreshSessions()
      void get().refreshDetail()
    }
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

  markSessionRead: (sessionId) => {
    const session = get().sessions.find(s => s.id === sessionId)
    if (!session) return
    const readSessionMarkers = {
      ...get().readSessionMarkers,
      [sessionId]: session.updatedAt,
    }
    set({ readSessionMarkers })
    saveReadMarkers(get().projectId ?? session.projectId, readSessionMarkers)
  },

  patchSession: (sessionId, patch) => {
    set(s => {
      const index = s.sessions.findIndex(sess => sess.id === sessionId)
      if (index === -1) return s
      const sessions = [...s.sessions]
      sessions[index] = patchAgentSession(sessions[index], patch)
      return { sessions }
    })
    const terminal = patch.status === 'completed'
      || patch.status === 'failed'
      || patch.status === 'cancelled'
      || patch.status === 'interrupted'
      || patch.status === 'blocked'
    if (terminal && get().selectedSessionId === sessionId && get().panelOpen) {
      get().markSessionRead(sessionId)
    }
  },
}))
