import { apiFetch, apiRequest } from './origin'
import { createAppError, handleError } from '../errors'

const BASE = '/api/agent-runtime'

export type AgentProfileKind = 'planner' | 'executor' | 'reviewer' | 'explorer'
export type AgentMode = 'primary' | 'subagent'
export type ThinkingMode = 'fast' | 'standard' | 'deep'
export type AgentSessionStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'paused'

export type AgentRunStatus =
  | 'running'
  | 'waiting_permission'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface AgentProfile {
  id: string
  label: string
  kind: AgentProfileKind
  mode: AgentMode
  description: string
  defaultThinkingMode: ThinkingMode
  allowedCapabilities: string[]
  defaultSkills: string[]
  maxSteps: number
  status: 'active' | 'disabled'
  allowsSubsessions?: boolean
}

export interface AgentSession {
  id: string
  projectId: string
  parentSessionId: string | null
  childSessionIds: string[]
  nodeId: string | null
  profileId: string
  status: AgentSessionStatus
  title: string | null
  prompt: string
  contextSnapshotId: string | null
  thinkingMode: ThinkingMode
  createdAt: string
  updatedAt: string
  completedAt: string | null
  resultSummary: string | null
  blockedReason: string | null
  skillIds: string[]
  activeRunId: string | null
  pendingResumeToken: string | null
  model: string | null
  sessionMetadata?: Record<string, unknown> | null
}

export interface AgentRun {
  id: string
  sessionId: string
  status: AgentRunStatus
  startedAt: string
  completedAt: string | null
  triggerMessageId: string | null
  currentStep: number
  stopReason: string | null
  model: string | null
  metadata: Record<string, unknown>
}

export interface AgentRunStep {
  id: string
  runId: string
  sessionId: string
  index: number
  status: AgentRunStatus
  model: string | null
  startedAt: string
  completedAt: string | null
  finishReason: string | null
  metadata: Record<string, unknown>
}

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'compacted'

export interface ToolCallRecord {
  id: string
  sessionId: string
  runId: string | null
  stepId: string | null
  toolId: string
  category: string
  mutability: 'read' | 'write' | 'task'
  inputSummary: string
  outputSummary: string | null
  status: ToolCallStatus
  startedAt: string
  endedAt: string | null
  error: string | null
}

export interface RuntimeEvent {
  id: string
  sessionId: string
  type: string
  timestamp: string
  visibility: 'user_visible' | 'internal'
  summary: string
  payload: Record<string, unknown>
}

export interface AgentRuntimeMessage {
  id: string
  sessionId: string
  runId: string | null
  stepId: string | null
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AgentSkillSummary {
  id: string
  label: string
  description: string
  source: 'system' | 'project' | 'plugin' | 'user'
  version: string
  appliesTo: AgentProfileKind[]
  requiredCapabilities: string[]
  permissionHints: string[]
  contentRef: string
  status: 'available' | 'unavailable' | 'invalid' | 'disabled'
}

export interface AgentContextBundle {
  id: string
  projectId: string
  sessionId: string | null
  nodeId: string | null
  profileId: string | null
  blocks: Array<{ id: string; kind: string; title: string; content: string }>
  citations: Array<Record<string, unknown>>
  warnings: string[]
  createdAt: string
}

export interface QueuedInput {
  id: string
  message: string
  model: string | null
  enqueuedAt: string
}

export interface PermissionDecision {
  id: string
  sessionId: string
  runId: string | null
  stepId: string | null
  toolCallId: string | null
  coarseCategory: 'read' | 'write' | 'external_execution' | 'high_risk'
  internalGate: string
  action: 'allow' | 'ask' | 'deny'
  reason: string
  patterns: string[]
  userReply: 'once' | 'always' | 'reject' | null
  createdAt: string
  resolvedAt: string | null
  resumeToken: string | null
  metadata: Record<string, unknown>
}

export interface EvidenceArtifact {
  id: string
  sessionId: string
  kind: string
  title: string
  summary: string
  sourceRefs: Array<{ type: string; id?: string; path?: string }>
  risk: 'low' | 'medium' | 'high' | 'unknown'
  createdAt: string
}

export interface CreateSessionRequest {
  projectId: string
  nodeId?: string | null
  profileId: string
  parentSessionId?: string | null
  prompt: string
  thinkingMode?: ThinkingMode
  skillIds?: string[]
  sessionMetadata?: Record<string, unknown> | null
  permissionTier?: 'readonly' | 'readwrite' | 'unrestricted'
  permissionOverrides?: Partial<Record<'read' | 'write' | 'delete' | 'shell' | 'task', 'allow' | 'ask' | 'deny'>>
}

export interface SessionPayload {
  session: AgentSession
  profile: AgentProfile
  context: AgentContextBundle | null
  candidateSkills: AgentSkillSummary[]
}

export interface SessionListResponse {
  items: AgentSession[]
  totalCount: number
  countByStatus: Record<string, number>
}

export interface DeleteSessionResult {
  ok: true
  deletedSessionIds: string[]
}

export interface SessionStats {
  tokenUsage: { input: number; output: number; total: number }
  contextLimit: number
  contextUsedPercent: number
  toolCallCount: number
  runningDuration: number
  status: AgentSessionStatus
  activeSubAgentCount: number
}

export interface TodoItem {
  id: string
  label: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface AgentToolSummary {
  id: string
  label: string
  description: string
  category: string
  mutability: 'read' | 'write' | 'task'
}

export interface SessionCapabilities {
  profile: { id: string; label: string; kind: string }
  tools: {
    available: AgentToolSummary[]
    visible: AgentToolSummary[]
  }
  skills: {
    active: AgentSkillSummary[]
    candidates: AgentSkillSummary[]
  }
}

export interface StreamTurnRequest {
  message?: string
  model?: string
  purpose?: string
  temperature?: number
  maxTokens?: number
  maxSteps?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return apiRequest<T>(`${BASE}${path}`, init)
}

export const agentRuntimeApi = {
  listProfiles: () => request<{ items: AgentProfile[] }>('/profiles'),
  listSkills: (profileId?: string) =>
    request<{ items: AgentSkillSummary[] }>(`/skills${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`),
  buildContext: (projectId: string, body: { nodeId?: string | null; profileId?: string; include?: string[] }) =>
    request<AgentContextBundle>(`/contexts/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createSession: (body: CreateSessionRequest) =>
    request<SessionPayload>('/sessions', { method: 'POST', body: JSON.stringify(body) }),
  listSessions: (query: {
    projectId?: string
    nodeId?: string
    status?: AgentSessionStatus
    limit?: number
    offset?: number
  } = {}) => {
    const qs = new URLSearchParams()
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) qs.set(key, String(value))
    })
    return request<SessionListResponse>(`/sessions${qs.size ? `?${qs.toString()}` : ''}`)
  },
  getSession: (sessionId: string) => request<SessionPayload>(`/sessions/${encodeURIComponent(sessionId)}`),
  cancelSession: (sessionId: string) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' }),
  deleteSession: (sessionId: string) =>
    request<DeleteSessionResult>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  clearInactiveSessions: (projectId: string) =>
    request<{ ok: true; deletedCount: number; deletedSessionIds: string[] }>(
      `/sessions/clear-inactive`,
      { method: 'POST', body: JSON.stringify({ projectId }) },
    ),
  listMessages: (sessionId: string) =>
    request<{ items: AgentRuntimeMessage[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`),
  listRuns: (sessionId: string) =>
    request<{ items: AgentRun[] }>(`/sessions/${encodeURIComponent(sessionId)}/runs`),
  getRun: (sessionId: string, runId: string) =>
    request<AgentRun>(`/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`),
  listRunSteps: (sessionId: string, runId: string) =>
    request<{ items: AgentRunStep[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/steps`,
    ),
  listSessionSteps: (sessionId: string) =>
    request<{ items: AgentRunStep[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/steps`,
    ),
  listEvents: (sessionId: string, after?: string) =>
    request<{ items: RuntimeEvent[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    ),
  listPermissions: (sessionId: string) =>
    request<{ items: PermissionDecision[] }>(`/sessions/${encodeURIComponent(sessionId)}/permissions`),
  replyPermission: (sessionId: string, permissionId: string, reply: 'once' | 'always' | 'reject', message?: string) =>
    request<PermissionDecision>(
      `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ reply, message }),
      },
    ),
  listArtifacts: (sessionId: string) =>
    request<{ items: EvidenceArtifact[] }>(`/sessions/${encodeURIComponent(sessionId)}/artifacts`),
  listToolCalls: (sessionId: string) =>
    request<{ items: ToolCallRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/tool-calls`),
  getSessionStats: (sessionId: string) =>
    request<SessionStats>(`/sessions/${encodeURIComponent(sessionId)}/stats`),
  getSessionTodos: (sessionId: string) =>
    request<{ items: TodoItem[] }>(`/sessions/${encodeURIComponent(sessionId)}/todos`),
  getSessionCapabilities: (sessionId: string) =>
    request<SessionCapabilities>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`),
  pauseSession: (sessionId: string) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(sessionId)}/pause`, { method: 'POST' }),
  resumeStream: async (
    sessionId: string,
    body: StreamTurnRequest,
    onChunk: (chunk: unknown) => void,
  ): Promise<void> => {
    const response = await apiFetch(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/resume/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      let message = `Agent runtime resume stream error ${response.status}`
      let code: string | undefined
      try {
        const b = await response.json() as { error?: string; code?: string }
        code = b.code
        if (b.code) message = b.error ?? message
        else if (b.error) message = b.error
      } catch { /* keep default message */ }
      const appErr = createAppError(message, response.status, code)
      handleError(appErr)
      throw appErr
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine) {
          const raw = dataLine.slice(6)
          if (raw === '[DONE]') return
          try { onChunk(JSON.parse(raw) as unknown) } catch { onChunk(raw) }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  },
  streamTurn: async (
    sessionId: string,
    body: StreamTurnRequest,
    onChunk: (chunk: unknown) => void,
  ): Promise<void> => {
    const response = await apiFetch(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/turns/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      let message = `Agent runtime turn stream error ${response.status}`
      let code: string | undefined
      try {
        const body = await response.json() as { error?: string; code?: string }
        code = body.code
        if (body.code) message = body.error ?? message
        else if (body.error) message = body.error
      } catch { /* keep default message */ }
      const appErr = createAppError(message, response.status, code)
      handleError(appErr)
      throw appErr
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
        if (dataLine) {
          const raw = dataLine.slice(6)
          if (raw === '[DONE]') return
          try {
            onChunk(JSON.parse(raw) as unknown)
          } catch {
            onChunk(raw)
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  },

  listInputQueue: (sessionId: string) =>
    apiRequest<{ items: QueuedInput[] }>(`${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue`),

  enqueueInput: (sessionId: string, body: { message: string; model?: string | null }) =>
    apiRequest<{ items: QueuedInput[] }>(`${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  removeQueuedInput: (sessionId: string, itemId: string) =>
    apiRequest<{ items: QueuedInput[] }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),

  forceQueuedInput: (sessionId: string, itemId: string) =>
    apiRequest<{ items: QueuedInput[]; forceInjectItemId: string }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}/force`,
      { method: 'POST' },
    ),
}
