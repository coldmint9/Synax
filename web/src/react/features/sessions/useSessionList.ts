import { useState, useMemo, useCallback } from 'react'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'
import type { AgentSession, AgentSessionStatus } from '../../../lib/api/agentRuntime'
import {
  isGoalSession,
  isWorkflowSession,
  type SessionListView,
} from './sessionBuckets'

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

// ---- Constants ----

const PAGE_SIZE = 30

// ---- Tree building ----

function buildTree(sessions: AgentSession[]): SessionTreeNode[] {
  const topLevel = sessions.filter(s => !s.parentSessionId)
  const childMap = new Map<string, AgentSession[]>()
  for (const s of sessions) {
    if (s.parentSessionId) {
      const arr = childMap.get(s.parentSessionId) ?? []
      arr.push(s)
      childMap.set(s.parentSessionId, arr)
    }
  }
  function node(s: AgentSession, depth: number): SessionTreeNode {
    const kids = (childMap.get(s.id) ?? [])
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    return { session: s, depth, children: kids.map(c => node(c, depth + 1)), expanded: depth < 2 }
  }
  return topLevel
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(s => node(s, 0))
}

function flattenTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
  const r: SessionTreeNode[] = []
  for (const n of nodes) {
    r.push(n)
    if (n.expanded && n.children.length) r.push(...flattenTree(n.children))
  }
  return r
}

// ---- Hook ----

export function useSessionList(locale: 'zh' | 'en' = 'zh', listView: SessionListView = 'goal') {
  const storeSessions = useDebugConsole(s => s.sessions)
  const storeRefresh = useDebugConsole(s => s.refreshSessions)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const openPanel = useDebugConsole(s => s.openPanel)
  const deleteSession = useDebugConsole(s => s.deleteSession)
  const projectId = useDebugConsole(s => s.projectId)

  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  const viewCounts = useMemo(() => {
    const topLevel = storeSessions.filter(s => !s.parentSessionId)
    let goal = 0
    let workflow = 0
    for (const session of topLevel) {
      if (isWorkflowSession(session)) workflow += 1
      else if (isGoalSession(session)) goal += 1
    }
    return { goal, workflow }
  }, [storeSessions])

  const grouped = useMemo(() => {
    let list = storeSessions.filter(s =>
      listView === 'workflow' ? isWorkflowSession(s) : isGoalSession(s),
    )
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(s => (s.title ?? s.prompt).toLowerCase().includes(q))
    }
    const tree = buildTree(list)
    return [{
      key: listView,
      label: listView === 'goal' ? (locale === 'zh' ? 'Goal' : 'Goals') : (locale === 'zh' ? 'Workflow' : 'Workflows'),
      sessions: tree,
      collapsed: collapsedGroups.has(listView),
      count: tree.length,
    }]
  }, [storeSessions, searchQuery, collapsedGroups, locale, listView])

  const visibleGroups = useMemo(() =>
    grouped.map(g => g.collapsed ? { ...g, sessions: [] } : {
      ...g,
      sessions: flattenTree(g.sessions.map(n => ({
        ...n,
        expanded: expandedNodes.has(n.session.id) ? true : n.expanded,
      }))),
    }),
  [grouped, expandedNodes])

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    setPage(0)
    setHasMore(true)
    await storeRefresh()
    try {
      const r = await agentRuntimeApi.listSessions({ projectId: projectId ?? undefined, limit: PAGE_SIZE, offset: 0 })
      setTotalCount(r.totalCount)
      setHasMore(r.items.length >= PAGE_SIZE)
    } finally {
      setIsRefreshing(false)
    }
  }, [projectId, storeRefresh])

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return
    setIsLoadingMore(true)
    const next = page + 1
    try {
      const r = await agentRuntimeApi.listSessions({ projectId: projectId ?? undefined, limit: PAGE_SIZE, offset: next * PAGE_SIZE })
      setPage(next)
      setHasMore(r.items.length >= PAGE_SIZE)
    } finally {
      setIsLoadingMore(false)
    }
  }, [projectId, page, isLoadingMore, hasMore])

  const toggleGroup = useCallback((key: string) =>
    setCollapsedGroups(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n }), [])

  const toggleExpand = useCallback((id: string) =>
    setExpandedNodes(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n }), [])

  const select = useCallback((id: string) => openPanel(id), [openPanel])

  return {
    groups: visibleGroups,
    listView,
    viewCounts,
    totalCount,
    hasMore,
    isLoadingMore,
    searchQuery,
    setSearchQuery,
    selectedId: panelOpen ? selectedSessionId : null,
    select,
    refresh,
    loadMore,
    toggleGroup,
    toggleExpand,
    deleteSession,
    isRefreshing,
  }
}

// Backward-compatible alias for SessionTimeGroups
export type TimeGroup = SessionGroup

/** @deprecated Status filter removed from Sessions page */
export type StatusFilter = AgentSessionStatus | 'all'
