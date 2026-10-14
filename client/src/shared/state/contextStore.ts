// ---------------------------------------------------------------------------
// web/src/react/state/contextStore.ts
//
// Zustand \u72b6\u6001\u7ba1\u7406\uff1a\u7ba1\u7406\u5f53\u524d\u9879\u76ee\u7684\u4f1a\u8bdd\u5217\u8868\u3001\u5f53\u524d\u4f1a\u8bdd\u3001\u6761\u76ee\u3001
// \u5feb\u7167\u548c\u957f\u671f\u8bb0\u5fc6\u3002\u9075\u5faa\u73b0\u6709 coordinatesStore \u7684 localStorage \u53cc\u5c42\u7f13\u5b58\u6a21\u5f0f\uff1a
//
//   - \u5185\u5b58\u72b6\u6001\u662f\u6743\u5a01\uff08\u4ece\u540e\u7aef\u52a0\u8f7d\u540e\u5199\u5165\uff09
//   - localStorage \u4ec5\u7528\u4e8e "\u5f53\u524d\u9009\u4e2d\u7684 sessionId" \u4e4b\u7c7b UI \u504f\u597d
//   - \u6570\u636e\u66f4\u6539\u624d\u7ed3\u4e3b\u8981\u901a\u8fc7 API \u6216 SSE \u63a8\u9001\u66f4\u65b0\u5230\u5185\u5b58
//
// \u8bbe\u8ba1\u8981\u70b9\uff1a
//   - actions \u90fd\u8fd4\u56de Promise\uff0c\u4fbf\u4e8e\u7ec4\u4ef6\u7b49\u5f85\u540e\u7ee7\u72b6\u6001\uff1b
//   - \u4e8b\u4ef6\u63a8\u9001\u589e\u91cf\u66f4\u65b0\uff0c\u907f\u514d\u5168\u91cf\u91cd\u65b0\u62c9\u53d6\uff1b
//   - \u5f02\u5e38\u5728 action \u5185\u90e8\u6355\u83b7\uff0c\u8bbe\u7f6e lastError\uff0cUI \u7edf\u4e00\u5448\u73b0\u3002
// ---------------------------------------------------------------------------

import { create } from 'zustand'
import {
  contextApi,
  type ContextEntry,
  type ContextSession,
  type ContextSnapshot,
  type ProjectMemory,
  type SearchHit,
  type SyncEvent,
  type Suggestion,
} from '../../adapters/transport/context'

const PREF_KEY = 'Synax.context.preferences'
const CONTEXT_CACHE_TTL_MS = 30_000

interface ProjectContextCache {
  sessions?: ContextSession[]
  memories?: ProjectMemory[]
  sessionsAt?: number
  memoriesAt?: number
  entries: Map<string, { items: ContextEntry[]; fetchedAt: number }>
  snapshots: Map<string, { items: ContextSnapshot[]; fetchedAt: number }>
}

const projectContextCache = new Map<string, ProjectContextCache>()

function getProjectCache(projectId: string): ProjectContextCache {
  let cache = projectContextCache.get(projectId)
  if (!cache) {
    cache = { entries: new Map(), snapshots: new Map() }
    projectContextCache.set(projectId, cache)
  }
  return cache
}

function isFresh(fetchedAt: number | undefined): boolean {
  return fetchedAt !== undefined && Date.now() - fetchedAt < CONTEXT_CACHE_TTL_MS
}

interface StoredPrefs {
  selectedSessionByProject: Record<string, string | null>
}

function readPrefs(): StoredPrefs {
  if (typeof window === 'undefined') return { selectedSessionByProject: {} }
  try {
    const raw = window.localStorage.getItem(PREF_KEY)
    if (!raw) return { selectedSessionByProject: {} }
    const parsed = JSON.parse(raw) as StoredPrefs
    return { selectedSessionByProject: parsed?.selectedSessionByProject ?? {} }
  } catch {
    return { selectedSessionByProject: {} }
  }
}

function writePrefs(prefs: StoredPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  } catch {
    /* quota exceeded \u7b49\u9677\u9609\u77e5\u5373\u53ef */
  }
}

// ============================== State Shape ==============================

interface ContextState {
  projectId: string | null
  userId: string

  sessions: ContextSession[]
  currentSessionId: string | null
  entries: ContextEntry[] // \u5f53\u524d\u4f1a\u8bdd\u7684\u6761\u76ee\uff08\u989d\u5916\u7f13\u5b58\uff09
  snapshots: ContextSnapshot[]

  memories: ProjectMemory[]
  pinnedMemoryIds: string[]

  searchResults: SearchHit[]
  suggestions: Suggestion[]

  loading: {
    sessions: boolean
    entries: boolean
    snapshots: boolean
    memories: boolean
    search: boolean
  }
  lastError: string | null

  tokenWarnings: Record<string, { tokenCount: number; threshold: number }>
  syncStatus: 'idle' | 'connecting' | 'connected' | 'error'

  // ---------- actions ----------
  bind(projectId: string, userId: string): void
  unbind(): void

  refreshSessions(): Promise<void>
  selectSession(sessionId: string | null): Promise<void>
  createOrResumeSession(sourceAgent?: string): Promise<ContextSession | null>
  archiveSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>

  refreshEntries(sessionId?: string): Promise<void>
  appendMessage(args: {
    role: ContextEntry['role']
    content: string
    contentType?: ContextEntry['contentType']
    metadata?: Record<string, unknown>
    parentEntryId?: string
  }): Promise<ContextEntry | null>
  recordSnapshot(label?: string): Promise<ContextSnapshot | null>
  refreshSnapshots(): Promise<void>

  refreshMemories(): Promise<void>
  createMemory(input: Parameters<typeof contextApi.createMemory>[0]): Promise<ProjectMemory | null>
  updateMemory(
    id: string,
    patch: Parameters<typeof contextApi.updateMemory>[1],
  ): Promise<ProjectMemory | null>
  deleteMemory(id: string): Promise<void>
  togglePinnedMemory(id: string): void
  getPinnedMemories(): ProjectMemory[]

  search(query: string, scope?: 'entries' | 'memories' | 'all'): Promise<void>
  clearSearch(): void
  suggest(partial: string): Promise<void>

  getRecentMessages(limit?: number): { role: 'user' | 'assistant'; content: string }[]

  // \u4f9b useContextStream hook \u8c03\u7528
  applySyncEvent(event: SyncEvent): void
  setSyncStatus(status: ContextState['syncStatus']): void
  clearTokenWarning(sessionId: string): void
}

// ============================== helpers ==============================

function upsertSession(list: ContextSession[], s: ContextSession): ContextSession[] {
  const idx = list.findIndex((x) => x.id === s.id)
  if (idx < 0) return [s, ...list]
  const next = list.slice()
  next[idx] = s
  return next
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((x) => x.id !== id)
}

// ============================== Store ==============================

export const useContextStore = create<ContextState>((set, get) => ({
  projectId: null,
  userId: 'local-user',
  sessions: [],
  currentSessionId: null,
  entries: [],
  snapshots: [],
  memories: [],
  pinnedMemoryIds: [],
  searchResults: [],
  suggestions: [],
  loading: {
    sessions: false,
    entries: false,
    snapshots: false,
    memories: false,
    search: false,
  },
  lastError: null,
  tokenWarnings: {},
  syncStatus: 'idle',

  bind(projectId, userId) {
    const prefs = readPrefs()
    const selected = prefs.selectedSessionByProject[projectId] ?? null
    const cache = getProjectCache(projectId)
    const cachedEntries = selected ? cache.entries.get(selected)?.items ?? [] : []
    const cachedSnapshots = selected ? cache.snapshots.get(selected)?.items ?? [] : []
    set({
      projectId,
      userId,
      currentSessionId: selected,
      sessions: cache.sessions ?? [],
      entries: cachedEntries,
      snapshots: cachedSnapshots,
      memories: cache.memories ?? [],
      searchResults: [],
      suggestions: [],
      tokenWarnings: {},
      syncStatus: 'idle',
      lastError: null,
    })
    void get().refreshSessions()
    void get().refreshMemories()
    if (selected) void get().refreshEntries(selected)
  },

  unbind() {
    set({
      projectId: null,
      sessions: [],
      currentSessionId: null,
      entries: [],
      snapshots: [],
      memories: [],
      searchResults: [],
      suggestions: [],
      tokenWarnings: {},
      syncStatus: 'idle',
    })
  },

  async refreshSessions() {
    const { projectId, loading } = get()
    if (!projectId) return
    const cache = getProjectCache(projectId)
    if (isFresh(cache.sessionsAt)) {
      if (cache.sessions) set({ sessions: cache.sessions })
      return
    }
    const requestProjectId = projectId
    set({ loading: { ...loading, sessions: true } })
    try {
      const resp = await contextApi.listSessions({ projectId, status: 'active', limit: 50 })
      cache.sessions = resp.items
      cache.sessionsAt = Date.now()
      if (get().projectId === requestProjectId) set({ sessions: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    } finally {
      set({ loading: { ...get().loading, sessions: false } })
    }
  },

  async selectSession(sessionId) {
    const { projectId } = get()
    set({ currentSessionId: sessionId })
    if (projectId) {
      const prefs = readPrefs()
      prefs.selectedSessionByProject[projectId] = sessionId
      writePrefs(prefs)
    }
    if (sessionId) {
      await Promise.all([get().refreshEntries(sessionId), get().refreshSnapshots()])
    } else {
      set({ entries: [], snapshots: [] })
    }
  },

  async createOrResumeSession(sourceAgent) {
    const { projectId, userId } = get()
    if (!projectId) return null
    try {
      const session = await contextApi.resumeSession({ projectId, userId, sourceAgent })
      set({
        sessions: upsertSession(get().sessions, session),
        currentSessionId: session.id,
      })
      const cache = getProjectCache(projectId)
      cache.sessions = upsertSession(cache.sessions ?? [], session)
      cache.sessionsAt = Date.now()
      const prefs = readPrefs()
      prefs.selectedSessionByProject[projectId] = session.id
      writePrefs(prefs)
      await get().refreshEntries(session.id)
      return session
    } catch (err) {
      set({ lastError: (err as Error).message })
      return null
    }
  },

  async archiveSession(sessionId) {
    try {
      const updated = await contextApi.archiveSession(sessionId)
      const projectId = get().projectId
      if (projectId) {
        const cache = getProjectCache(projectId)
        cache.sessions = (cache.sessions ?? []).filter((s) => s.id !== sessionId)
        cache.sessionsAt = 0
      }
      set({
        sessions: get().sessions.filter((s) => s.id !== sessionId),
        currentSessionId: get().currentSessionId === sessionId ? null : get().currentSessionId,
      })
      if (get().currentSessionId === sessionId) set({ entries: [], snapshots: [] })
      void updated
    } catch (err) {
      set({ lastError: (err as Error).message })
    }
  },

  async deleteSession(sessionId) {
    try {
      const wasCurrent = get().currentSessionId === sessionId
      await contextApi.deleteSession(sessionId)
      const projectId = get().projectId
      if (projectId) {
        const cache = getProjectCache(projectId)
        cache.sessions = (cache.sessions ?? []).filter((s) => s.id !== sessionId)
        cache.sessionsAt = 0
        cache.entries.delete(sessionId)
        cache.snapshots.delete(sessionId)
      }
      set({
        sessions: get().sessions.filter((s) => s.id !== sessionId),
        currentSessionId: wasCurrent ? null : get().currentSessionId,
        ...(wasCurrent ? { entries: [], snapshots: [] } : {}),
      })
    } catch (err) {
      set({ lastError: (err as Error).message })
    }
  },

  async refreshEntries(sessionId) {
    const { projectId } = get()
    const sid = sessionId ?? get().currentSessionId
    if (!projectId || !sid) return
    const cache = getProjectCache(projectId)
    const cached = cache.entries.get(sid)
    if (cached && isFresh(cached.fetchedAt)) {
      if (get().currentSessionId === sid) set({ entries: cached.items })
      return
    }
    const requestProjectId = projectId
    set({ loading: { ...get().loading, entries: true } })
    try {
      const resp = await contextApi.listEntries(sid, { limit: 200 })
      cache.entries.set(sid, { items: resp.items, fetchedAt: Date.now() })
      if (get().projectId === requestProjectId && get().currentSessionId === sid)
        set({ entries: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    } finally {
      set({ loading: { ...get().loading, entries: false } })
    }
  },

  async appendMessage({ role, content, contentType, metadata, parentEntryId }) {
    const { currentSessionId, projectId } = get()
    if (!currentSessionId) return null
    try {
      const entry = await contextApi.appendEntry(currentSessionId, {
        role,
        content,
        contentType,
        metadata,
        parentEntryId,
      })
      const entries = [...get().entries, entry]
      if (projectId) getProjectCache(projectId).entries.set(currentSessionId, {
        items: entries,
        fetchedAt: Date.now(),
      })
      set({ entries })
      return entry
    } catch (err) {
      set({ lastError: (err as Error).message })
      return null
    }
  },

  async recordSnapshot(label) {
    const { currentSessionId, projectId } = get()
    if (!currentSessionId) return null
    try {
      const snap = await contextApi.createSnapshot(currentSessionId, { label })
      const snapshots = [snap, ...get().snapshots]
      if (projectId) getProjectCache(projectId).snapshots.set(currentSessionId, {
        items: snapshots,
        fetchedAt: Date.now(),
      })
      set({ snapshots })
      return snap
    } catch (err) {
      set({ lastError: (err as Error).message })
      return null
    }
  },

  async refreshSnapshots() {
    const { currentSessionId: sid, projectId } = get()
    if (!sid || !projectId) return
    const cache = getProjectCache(projectId)
    const cached = cache.snapshots.get(sid)
    if (cached && isFresh(cached.fetchedAt)) {
      set({ snapshots: cached.items })
      return
    }
    const requestProjectId = projectId
    set({ loading: { ...get().loading, snapshots: true } })
    try {
      const resp = await contextApi.listSnapshots(sid)
      cache.snapshots.set(sid, { items: resp.items, fetchedAt: Date.now() })
      if (get().projectId === requestProjectId && get().currentSessionId === sid)
        set({ snapshots: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    } finally {
      set({ loading: { ...get().loading, snapshots: false } })
    }
  },

  async refreshMemories() {
    const { projectId } = get()
    if (!projectId) return
    const cache = getProjectCache(projectId)
    if (isFresh(cache.memoriesAt)) {
      if (cache.memories) set({ memories: cache.memories })
      return
    }
    const requestProjectId = projectId
    set({ loading: { ...get().loading, memories: true } })
    try {
      const resp = await contextApi.listMemories({ projectId, status: 'active', limit: 200 })
      cache.memories = resp.items
      cache.memoriesAt = Date.now()
      if (get().projectId === requestProjectId) set({ memories: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    } finally {
      set({ loading: { ...get().loading, memories: false } })
    }
  },

  async createMemory(input) {
    try {
      const mem = await contextApi.createMemory(input)
      const memories = [mem, ...get().memories]
      const projectId = get().projectId
      if (projectId) {
        const cache = getProjectCache(projectId)
        cache.memories = memories
        cache.memoriesAt = Date.now()
      }
      set({ memories })
      return mem
    } catch (err) {
      set({ lastError: (err as Error).message })
      return null
    }
  },

  async updateMemory(id, patch) {
    try {
      const mem = await contextApi.updateMemory(id, patch)
      const memories = get().memories.map((m) => (m.id === id ? mem : m))
      const projectId = get().projectId
      if (projectId) getProjectCache(projectId).memories = memories
      set({ memories })
      return mem
    } catch (err) {
      set({ lastError: (err as Error).message })
      return null
    }
  },

  async deleteMemory(id) {
    try {
      await contextApi.deleteMemory(id)
      const memories = removeById(get().memories, id)
      const projectId = get().projectId
      if (projectId) getProjectCache(projectId).memories = memories
      set({
        memories,
        pinnedMemoryIds: get().pinnedMemoryIds.filter((x) => x !== id),
      })
    } catch (err) {
      set({ lastError: (err as Error).message })
    }
  },

  togglePinnedMemory(id) {
    const pinned = get().pinnedMemoryIds
    if (pinned.includes(id)) {
      set({ pinnedMemoryIds: pinned.filter((x) => x !== id) })
    } else {
      set({ pinnedMemoryIds: [...pinned, id] })
    }
  },

  getPinnedMemories() {
    const pinned = new Set(get().pinnedMemoryIds)
    return get().memories.filter((m) => pinned.has(m.id))
  },

  async search(query, scope = 'all') {
    const { projectId } = get()
    if (!projectId) return
    set({ loading: { ...get().loading, search: true } })
    try {
      const resp = await contextApi.search({ projectId, query, scope, limit: 30 })
      set({ searchResults: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    } finally {
      set({ loading: { ...get().loading, search: false } })
    }
  },

  clearSearch() {
    set({ searchResults: [], suggestions: [] })
  },

  async suggest(partial) {
    const { projectId } = get()
    if (!projectId || partial.trim().length < 2) {
      set({ suggestions: [] })
      return
    }
    try {
      const resp = await contextApi.suggest({ projectId, partialIntent: partial, limit: 5 })
      set({ suggestions: resp.items })
    } catch (err) {
      set({ lastError: (err as Error).message })
    }
  },

  getRecentMessages(limit = 6) {
    const entries = get().entries
    return entries
      .filter((e) => e.role === 'user' || e.role === 'assistant')
      .slice(-limit)
      .map((e) => ({ role: e.role as 'user' | 'assistant', content: e.content }))
  },

  applySyncEvent(event) {
    switch (event.type) {
      case 'session_created':
      case 'session_updated':
      case 'session_archived': {
        const s = event.payload as ContextSession
        if (!s?.id) return
        const projectId = get().projectId
        const cache = projectId ? getProjectCache(projectId) : undefined
        if (event.type === 'session_archived') {
          if (cache) {
            cache.sessions = (cache.sessions ?? []).filter((x) => x.id !== s.id)
            cache.sessionsAt = Date.now()
          }
          set({
            sessions: get().sessions.filter((x) => x.id !== s.id),
            currentSessionId:
              get().currentSessionId === s.id ? null : get().currentSessionId,
          })
        } else {
          const sessions = upsertSession(get().sessions, s)
          if (cache) {
            cache.sessions = upsertSession(cache.sessions ?? [], s)
            cache.sessionsAt = Date.now()
          }
          set({ sessions })
        }
        return
      }
      case 'session_deleted': {
        const id = (event.payload as { id: string }).id
        const projectId = get().projectId
        if (projectId) {
          const cache = getProjectCache(projectId)
          cache.sessions = (cache.sessions ?? []).filter((x) => x.id !== id)
          cache.sessionsAt = Date.now()
          cache.entries.delete(id)
          cache.snapshots.delete(id)
        }
        set({
          sessions: removeById(get().sessions, id),
          currentSessionId: get().currentSessionId === id ? null : get().currentSessionId,
        })
        return
      }
      case 'entry_created': {
        const entry = event.payload as ContextEntry
        if (entry.sessionId !== get().currentSessionId) return
        if (get().entries.some((x) => x.id === entry.id)) return
        const entries = [...get().entries, entry]
        const projectId = get().projectId
        if (projectId) getProjectCache(projectId).entries.set(entry.sessionId, {
          items: entries,
          fetchedAt: Date.now(),
        })
        set({ entries })
        return
      }
      case 'entry_updated': {
        const entry = event.payload as ContextEntry
        const entries = get().entries.map((x) => (x.id === entry.id ? entry : x))
        const projectId = get().projectId
        if (projectId) getProjectCache(projectId).entries.set(entry.sessionId, {
          items: entries,
          fetchedAt: Date.now(),
        })
        set({ entries })
        return
      }
      case 'entry_deleted': {
        const id = (event.payload as { id: string }).id
        const entries = removeById(get().entries, id)
        const projectId = get().projectId
        if (projectId && get().currentSessionId)
          getProjectCache(projectId).entries.set(get().currentSessionId!, {
            items: entries,
            fetchedAt: Date.now(),
          })
        set({ entries })
        return
      }
      case 'snapshot_created': {
        const snap = event.payload as ContextSnapshot
        if (snap.sessionId !== get().currentSessionId) return
        const snapshots = [snap, ...get().snapshots.filter((x) => x.id !== snap.id)]
        const projectId = get().projectId
        if (projectId) getProjectCache(projectId).snapshots.set(snap.sessionId, {
          items: snapshots,
          fetchedAt: Date.now(),
        })
        set({ snapshots })
        return
      }
      case 'memory_created':
      case 'memory_updated': {
        const m = event.payload as ProjectMemory
        const exists = get().memories.find((x) => x.id === m.id)
        set({
          memories: exists
            ? get().memories.map((x) => (x.id === m.id ? m : x))
            : [m, ...get().memories],
        })
        return
      }
      case 'memory_deleted': {
        const id = (event.payload as { id: string }).id
        set({
          memories: removeById(get().memories, id),
          pinnedMemoryIds: get().pinnedMemoryIds.filter((x) => x !== id),
        })
        return
      }
      case 'session_token_warning': {
        const p = event.payload as { tokenCount: number; threshold: number }
        if (!event.sessionId) return
        set({
          tokenWarnings: { ...get().tokenWarnings, [event.sessionId]: p },
        })
        return
      }
      default:
        return
    }
  },

  setSyncStatus(status) {
    set({ syncStatus: status })
  },

  clearTokenWarning(sessionId) {
    const { [sessionId]: _omit, ...rest } = get().tokenWarnings
    set({ tokenWarnings: rest })
  },
}))
