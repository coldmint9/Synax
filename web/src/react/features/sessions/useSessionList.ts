import { useState, useMemo, useCallback, useRef, useDeferredValue } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import type { AgentSession, AgentSessionStatus } from '../../../lib/api/agentRuntime'
import {
  isGoalModeSession,
  isWorkflowSession,
  listRootSessions,
  type SessionListView,
} from './sessionBuckets'
import { sessionPath, workflowSessionPath, isNewSessionPath, newSessionPath } from './sessionRoutes'

// ---- Types ----

export interface SessionTreeNode {
  session: AgentSession
  depth: number
  children: SessionTreeNode[]
  expanded: boolean
}

export interface SessionGroup {
  key: SessionListView
  label: string
  sessions: SessionTreeNode[]
  collapsed: boolean
  count: number
}

// ---- Hook ----

export function useSessionList(
  locale: 'zh' | 'en' = 'zh',
  listView: SessionListView = 'sessions',
  routeProjectId = '',
) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const storeProjectId = useAgentSessionStore((s) => s.projectId)
  const storeSessions = useAgentSessionStore((s) => s.sessions)
  const storeRefresh = useAgentSessionStore((s) => s.refreshSessions)
  const deleteSession = useAgentSessionStore((s) => s.deleteSession)

  const projectSessions = useMemo(() => {
    if (!routeProjectId) return []
    return storeSessions.filter((s) => s.projectId === routeProjectId)
  }, [routeProjectId, storeSessions])

  const isProjectReady = Boolean(routeProjectId) && storeProjectId === routeProjectId

  const total = useAgentSessionStore((s) => s.sessionListTotal)
  const totalCount = total ?? projectSessions.length
  const offset = useAgentSessionStore((s) => s.sessionListOffset)
  const hasMore = total !== null && offset < total
  const isRefreshing = useAgentSessionStore((s) => s.sessionListLoading)
  const error = useAgentSessionStore((s) => s.sessionListError)
  const storeLoadMore = useAgentSessionStore((s) => s.loadMoreSessions)
  const loadingMore = useRef(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredQuery = useDeferredValue(searchQuery)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const nodeCache = useMemo(() => new WeakMap<AgentSession, SessionTreeNode>(), [routeProjectId])

  const isDraftOpen = listView === 'sessions' && isNewSessionPath(location.pathname)
  const selectedIdFromUrl = searchParams.get('session')

  const viewCounts = useMemo(() => {
    const topLevel = projectSessions.filter((s) => !s.parentSessionId)
    let sessionsCount = 0
    let workflow = 0
    for (const session of topLevel) {
      if (isWorkflowSession(session)) workflow += 1
      else if (isGoalModeSession(session)) sessionsCount += 1
    }
    return { sessions: sessionsCount, workflow }
  }, [projectSessions])

  const grouped = useMemo(() => {
    let list = listRootSessions(projectSessions).filter((s) =>
      listView === 'workflow' ? isWorkflowSession(s) : isGoalModeSession(s),
    )
    if (deferredQuery.trim()) {
      const q = deferredQuery.trim().toLowerCase()
      list = list.filter((s) => (s.title ?? s.prompt).toLowerCase().includes(q))
    }
    // This view deliberately contains roots only; do not rebuild a recursive tree.
    const tree = list
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((session) => {
        let node = nodeCache.get(session)
        if (!node) {
          node = { session, depth: 0, children: [], expanded: false }
          nodeCache.set(session, node)
        }
        return node
      })
    return [
      {
        key: listView,
        label:
          listView === 'sessions'
            ? locale === 'zh'
              ? '会话'
              : 'Sessions'
            : locale === 'zh'
              ? 'Workflow'
              : 'Workflows',
        sessions: tree,
        collapsed: collapsedGroups.has(listView),
        count: tree.length,
      },
    ]
  }, [projectSessions, deferredQuery, collapsedGroups, locale, listView, nodeCache])

  const visibleGroups = useMemo(
    () => grouped.map((group) => (group.collapsed ? { ...group, sessions: [] } : group)),
    [grouped],
  )

  const refresh = useCallback(
    async (options?: { joinPending?: boolean }) => {
      if (!routeProjectId || !isProjectReady) return
      await storeRefresh(options)
    },
    [isProjectReady, routeProjectId, storeRefresh],
  )

  const loadMore = useCallback(async () => {
    if (!routeProjectId || !isProjectReady || loadingMore.current || !hasMore) return
    loadingMore.current = true
    setIsLoadingMore(true)
    try {
      await storeLoadMore()
    } finally {
      loadingMore.current = false
      setIsLoadingMore(false)
    }
  }, [routeProjectId, isProjectReady, hasMore, storeLoadMore])

  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsedGroups((p) => {
        const n = new Set(p)
        n.has(key) ? n.delete(key) : n.add(key)
        return n
      }),
    [],
  )

  // Root-only list; shared row props still accept the expansion callback.
  const toggleExpand = useCallback((_id: string) => {}, [])

  const select = useCallback(
    (id: string) => {
      if (!routeProjectId) return
      useAgentSessionStore.getState().markSessionRead(id)
      navigate(
        listView === 'workflow' ? workflowSessionPath(routeProjectId, id) : sessionPath(routeProjectId, id),
      )
    },
    [listView, navigate, routeProjectId],
  )

  const openNewDraft = useCallback(() => {
    if (!routeProjectId || listView !== 'sessions') return
    navigate(newSessionPath(routeProjectId))
  }, [listView, navigate, routeProjectId])

  return {
    groups: visibleGroups,
    listView,
    viewCounts,
    totalCount,
    hasMore,
    isLoadingMore,
    searchQuery,
    setSearchQuery,
    selectedId: isDraftOpen ? null : selectedIdFromUrl,
    select,
    openNewDraft,
    isDraftOpen,
    refresh,
    loadMore,
    toggleGroup,
    toggleExpand,
    deleteSession,
    isRefreshing,
    error,
    isProjectReady,
  }
}

// Backward-compatible alias for SessionTimeGroups
export type TimeGroup = SessionGroup

/** @deprecated Status filter removed from Sessions page */
export type StatusFilter = AgentSessionStatus | 'all'
