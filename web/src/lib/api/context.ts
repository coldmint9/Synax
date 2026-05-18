// ---------------------------------------------------------------------------
// web/src/lib/api/context.ts — \u4e0a\u4e0b\u6587\u7ba1\u7406\u7cfb\u7edf\u524d\u7aef API \u5ba2\u6237\u7aef
//
// \u4e0e api/services/contracts/context.ts \u4fdd\u6301\u7ed3\u6784\u4e00\u81f4\uff08\u89c1 spec \u7ea6\u675f\uff0c
// Python/TS \u53cc\u7aef\u624b\u52a8\u540c\u6b65\uff09\u3002
// ---------------------------------------------------------------------------

import { apiFetch, getApiOrigin } from './origin'

const API_BASE = '/api/context'

// ============================== \u9886\u57df\u7c7b\u578b ==============================

export type SessionStatus = 'active' | 'archived' | 'expired'
export type EntryRole = 'user' | 'assistant' | 'system' | 'tool'
export type EntryContentType = 'text' | 'code' | 'tool_call' | 'tool_result' | 'markdown'
export type MemoryType =
  | 'pattern'
  | 'decision'
  | 'preference'
  | 'convention'
  | 'insight'
  | 'risk'
export type MemoryStatus = 'active' | 'archived' | 'superseded'
export type LinkType =
  | 'mentions'
  | 'discusses'
  | 'creates'
  | 'modifies'
  | 'references'
  | 'resolves'
export type ContextBlockKind =
  | 'entry'
  | 'memory'
  | 'decision'
  | 'constraint'
  | 'risk'
  | 'artifact'
  | 'evidence'
  | 'bundle'
  | 'snapshot'
  | 'correction'
  | 'review'
  | 'system'
export type ContextBindingRelation =
  | 'uses'
  | 'references'
  | 'constrains'
  | 'resolves'
  | 'produces'
  | 'contains'
  | 'mentions'
  | 'discusses'
  | 'creates'
  | 'modifies'

export interface ContextSession {
  id: string
  projectId: string
  userId: string
  status: SessionStatus
  title: string | null
  summary: string | null
  tokenCount: number
  entryCount: number
  sourceAgent: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  archivedAt: string | null
}

export interface ContextEntry {
  id: string
  sessionId: string
  projectId: string
  sequence: number
  role: EntryRole
  content: string
  contentType: EntryContentType
  tokenEstimate: number
  metadata: Record<string, unknown>
  parentEntryId: string | null
  createdAt: string
}

export interface ContextSnapshot {
  id: string
  sessionId: string
  projectId: string
  label: string | null
  fromSequence: number
  toSequence: number
  entryCount: number
  compressedContent: string | null
  diffBaseId: string | null
  createdAt: string
  createdBy: string | null
}

export interface ProjectMemory {
  id: string
  projectId: string
  memoryType: MemoryType
  title: string
  content: string
  sourceSessionId: string | null
  sourceEntryId: string | null
  tags: string[]
  confidence: number
  accessCount: number
  references: { nodeIds?: string[]; filePaths?: string[]; [k: string]: unknown }
  status: MemoryStatus
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export interface ContextLink {
  id: string
  entryId: string
  nodeId: string
  projectId: string
  linkType: LinkType
  confidence: number
  createdAt: string
}

export interface ContextBlock {
  id: string
  projectId: string
  kind: ContextBlockKind
  title: string
  content: string
  status: 'active' | 'archived' | 'superseded'
  sourceType: string | null
  sourceId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface ContextBinding {
  id: string
  projectId: string
  blockId: string
  targetKind: 'node' | 'run' | 'run_event' | 'source_link' | 'block'
  targetId: string
  relation: ContextBindingRelation
  confidence: number
  metadata: Record<string, unknown>
  createdAt: string
  createdBy: string | null
}

export interface ContextSuggestion {
  block: ContextBlock
  relation: ContextBindingRelation
  score: number
  reason: string
}

export type AgentLoopStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentLoopStepKind =
  | 'user_input'
  | 'context_snapshot'
  | 'agent_thought'
  | 'agent_message'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'final_output'
  | 'error'

export interface AgentLoopStep {
  id: string
  loopId: string
  projectId: string
  runId: string
  sequence: number
  kind: AgentLoopStepKind
  title: string
  content: string
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AgentLoopTranscript {
  userInput: string
  contextSnapshotId: string | null
  steps: Array<Pick<AgentLoopStep, 'sequence' | 'kind' | 'title' | 'content' | 'payload' | 'metadata'>>
}

export interface AgentLoopRecord {
  id: string
  projectId: string
  turnId: string
  nodeId: string | null
  runId: string
  provider: string
  status: AgentLoopStatus
  summary: string | null
  finalOutput: string | null
  contextSnapshotId: string | null
  transcript: AgentLoopTranscript
  fileChanges: unknown[]
  metadata: Record<string, unknown>
  startedAt: string
  completedAt: string | null
  steps?: AgentLoopStep[]
}

export type ContextSignalKind =
  | 'decision'
  | 'risk'
  | 'constraint'
  | 'evidence'
  | 'artifact'
  | 'correction'
  | 'insight'
export type ContextSignalSourceType = 'agent_loop_record' | 'review' | 'manual_note'
export type ContextDisclosureStatus = 'pending' | 'accepted' | 'dismissed' | 'auto_applied'

export interface ContextSignal {
  id: string
  projectId: string
  blockId: string
  sourceType: ContextSignalSourceType
  sourceId: string
  sourceNodeId: string | null
  sourceRunId: string | null
  kind: ContextSignalKind
  title: string
  summary: string
  content: string
  confidence: number
  tags: string[]
  sourceLinks: string[]
  metadata: Record<string, unknown>
  createdAt: string
  createdBy: string | null
}

export interface ContextDisclosureSuggestion {
  id: string
  projectId: string
  signalId: string
  sourceNodeId: string | null
  targetNodeId: string
  relation: ContextBindingRelation
  confidence: number
  reason: string
  status: ContextDisclosureStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  decidedBy: string | null
  decidedAt: string | null
}

export interface Paginated<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

export interface SearchHit {
  kind: 'entry' | 'memory'
  id: string
  projectId: string
  sessionId?: string
  title?: string
  snippet: string
  score: number
  createdAt: string
}

export interface Suggestion {
  text: string
  source: 'memory' | 'entry'
  refId: string
  score: number
}

export type SyncEventType =
  | 'session_created'
  | 'session_updated'
  | 'session_archived'
  | 'session_deleted'
  | 'entry_created'
  | 'entry_updated'
  | 'entry_deleted'
  | 'snapshot_created'
  | 'memory_created'
  | 'memory_updated'
  | 'memory_deleted'
  | 'link_created'
  | 'link_deleted'
  | 'session_token_warning'
  | 'context_block_created'
  | 'context_block_updated'
  | 'context_binding_created'
  | 'context_binding_deleted'
  | 'context_snapshot_created'
  | 'context_bundle_created'
  | 'coord_event_created'
  | 'coordinates_state_saved'
  | 'ready'
  | 'ping'

export interface SyncEvent<T = unknown> {
  type: SyncEventType
  projectId: string
  sessionId?: string
  payload: T
  timestamp: number
}

// ============================== fetch \u8f85\u52a9 ==============================

async function parseJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
  }
  return (await resp.json()) as T
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(parseJson<T>)
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(parseJson<T>)
}

function getJson<T>(path: string): Promise<T> {
  return apiFetch(`${API_BASE}${path}`).then(parseJson<T>)
}

function deleteJson<T>(path: string): Promise<T> {
  return apiFetch(`${API_BASE}${path}`, { method: 'DELETE' }).then(parseJson<T>)
}

function buildQs(params: Record<string, unknown>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

// ============================== API \u65b9\u6cd5 ==============================

export const contextApi = {
  // ---------- session ----------
  listSessions(params: {
    projectId: string
    status?: SessionStatus
    userId?: string
    limit?: number
    offset?: number
  }): Promise<Paginated<ContextSession>> {
    return getJson(`/sessions${buildQs(params)}`)
  },

  createSession(body: {
    projectId: string
    userId: string
    title?: string
    sourceAgent?: string
    ttlHours?: number
  }): Promise<ContextSession> {
    return postJson('/sessions', body)
  },

  resumeSession(body: {
    projectId: string
    userId: string
    sourceAgent?: string
  }): Promise<ContextSession> {
    return postJson('/sessions/resume', body)
  },

  getSession(id: string): Promise<ContextSession> {
    return getJson(`/sessions/${encodeURIComponent(id)}`)
  },

  updateSession(
    id: string,
    patch: Partial<Pick<ContextSession, 'title' | 'summary' | 'status'>>,
  ): Promise<ContextSession> {
    return patchJson(`/sessions/${encodeURIComponent(id)}`, patch)
  },

  archiveSession(id: string): Promise<ContextSession> {
    return deleteJson(`/sessions/${encodeURIComponent(id)}`)
  },

  deleteSession(id: string): Promise<{ ok: true }> {
    return deleteJson(`/sessions/${encodeURIComponent(id)}?hard=1`)
  },

  // ---------- entry ----------
  listEntries(
    sessionId: string,
    opts: { offset?: number; limit?: number; afterSequence?: number } = {},
  ): Promise<Paginated<ContextEntry>> {
    return getJson(`/sessions/${encodeURIComponent(sessionId)}/entries${buildQs(opts)}`)
  },

  appendEntry(
    sessionId: string,
    body: {
      role: EntryRole
      content: string
      contentType?: EntryContentType
      tokenEstimate?: number
      metadata?: Record<string, unknown>
      parentEntryId?: string
    },
  ): Promise<ContextEntry> {
    return postJson(`/sessions/${encodeURIComponent(sessionId)}/entries`, body)
  },

  updateEntry(
    sessionId: string,
    entryId: string,
    patch: { content?: string; metadata?: Record<string, unknown> },
  ): Promise<ContextEntry> {
    return patchJson(
      `/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}`,
      patch,
    )
  },

  deleteEntry(sessionId: string, entryId: string): Promise<{ ok: true }> {
    return deleteJson(
      `/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}`,
    )
  },

  // 轻量 by-id 读取（不带 sessionId）
  getEntry(entryId: string): Promise<ContextEntry> {
    return getJson(`/entries/${encodeURIComponent(entryId)}`)
  },

  // ---------- snapshot ----------
  listSnapshots(sessionId: string): Promise<{ items: ContextSnapshot[] }> {
    return getJson(`/sessions/${encodeURIComponent(sessionId)}/snapshots`)
  },

  createSnapshot(
    sessionId: string,
    body: Partial<Pick<ContextSnapshot, 'label' | 'compressedContent' | 'createdBy'>> & {
      fromSequence?: number
      toSequence?: number
      diffBaseId?: string
    } = {},
  ): Promise<ContextSnapshot> {
    return postJson(`/sessions/${encodeURIComponent(sessionId)}/snapshots`, body)
  },

  // ---------- memory ----------
  listMemories(params: {
    projectId: string
    memoryType?: MemoryType
    status?: MemoryStatus
    tag?: string
    limit?: number
    offset?: number
  }): Promise<Paginated<ProjectMemory>> {
    return getJson(`/memories${buildQs(params)}`)
  },

  createMemory(body: {
    projectId: string
    memoryType: MemoryType
    title: string
    content: string
    tags?: string[]
    confidence?: number
    references?: ProjectMemory['references']
    sourceSessionId?: string | null
    sourceEntryId?: string | null
    expiresAt?: string | null
  }): Promise<ProjectMemory> {
    return postJson('/memories', body)
  },

  updateMemory(
    id: string,
    patch: Partial<
      Pick<
        ProjectMemory,
        'title' | 'content' | 'tags' | 'confidence' | 'status' | 'memoryType' | 'references'
      >
    >,
  ): Promise<ProjectMemory> {
    return patchJson(`/memories/${encodeURIComponent(id)}`, patch)
  },

  deleteMemory(id: string): Promise<{ ok: true }> {
    return deleteJson(`/memories/${encodeURIComponent(id)}`)
  },

  // ---------- search ----------
  search(body: {
    projectId: string
    query: string
    scope?: 'entries' | 'memories' | 'all'
    limit?: number
    role?: EntryRole
    memoryType?: MemoryType
    sessionId?: string
  }): Promise<{ items: SearchHit[] }> {
    return postJson('/search', body)
  },

  suggest(body: {
    projectId: string
    partialIntent: string
    limit?: number
  }): Promise<{ items: Suggestion[] }> {
    return postJson('/suggest', body)
  },

  // ---------- links ----------
  createLink(body: {
    projectId: string
    entryId: string
    nodeId: string
    linkType: LinkType
    confidence?: number
  }): Promise<ContextLink> {
    return postJson('/links', body)
  },

  linksByNode(projectId: string, nodeId: string): Promise<{ items: ContextLink[] }> {
    return getJson(`/links${buildQs({ projectId, nodeId })}`)
  },

  linksByEntry(entryId: string): Promise<{ items: ContextLink[] }> {
    return getJson(`/links${buildQs({ entryId })}`)
  },

  deleteLink(id: string): Promise<{ ok: true }> {
    return deleteJson(`/links/${encodeURIComponent(id)}`)
  },

  suggestContext(params: {
    projectId: string
    nodeId?: string
    runId?: string
    limit?: number
  }): Promise<{ items: ContextSuggestion[] }> {
    return getJson(`/suggestions${buildQs(params)}`)
  },

  // ---------- export / import ----------
  exportProject(projectId: string): Promise<{
    projectId: string
    exportedAt: string
    sessions: ContextSession[]
    entries: ContextEntry[]
    snapshots: ContextSnapshot[]
    memories: ProjectMemory[]
    links: ContextLink[]
  }> {
    return postJson('/export', { projectId })
  },

  importProject(body: {
    projectId: string
    strategy?: 'replace' | 'merge'
    data: {
      projectId: string
      exportedAt?: string
      sessions?: ContextSession[]
      entries?: ContextEntry[]
      snapshots?: ContextSnapshot[]
      memories?: ProjectMemory[]
      links?: ContextLink[]
    }
  }): Promise<{
    ok: true
    result: { sessions: number; entries: number; snapshots: number; memories: number; links: number }
  }> {
    return postJson('/import', body)
  },

  // ---------- sync (SSE) ----------
  /**
   * \u8ba2\u9605\u9879\u76ee\u4e0a\u4e0b\u6587\u540c\u6b65\u4e8b\u4ef6\u6d41\u3002
   * @returns \u89e3\u9664\u8ba2\u9605\u51fd\u6570
   */
  subscribeSync(projectId: string, onEvent: (event: SyncEvent) => void): () => void {
    const url = `${getApiOrigin()}${API_BASE}/sync?projectId=${encodeURIComponent(projectId)}`
    const es = new EventSource(url)
    const types: SyncEventType[] = [
      'session_created',
      'session_updated',
      'session_archived',
      'session_deleted',
      'entry_created',
      'entry_updated',
      'entry_deleted',
      'snapshot_created',
      'memory_created',
      'memory_updated',
      'memory_deleted',
      'link_created',
      'link_deleted',
      'session_token_warning',
      'context_block_created',
      'context_block_updated',
      'context_binding_created',
      'context_binding_deleted',
      'context_snapshot_created',
      'context_bundle_created',
      'coord_event_created',
      'coordinates_state_saved',
      'ready',
      'ping',
    ]
    for (const t of types) {
      es.addEventListener(t, (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as SyncEvent
          onEvent(parsed)
        } catch {
          /* ignore malformed frame */
        }
      })
    }
    return () => es.close()
  },
}
