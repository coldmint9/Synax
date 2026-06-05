import { useState, useMemo, useCallback } from 'react'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'
import type { AgentSession, AgentSessionStatus } from '../../../lib/api/agentRuntime'

// ---- Types ----

export interface SessionTreeNode {
  session: AgentSession
  depth: number
  children: SessionTreeNode[]
  expanded: boolean
}

export interface TimeGroup {
  key: string
  label: string
  sessions: SessionTreeNode[]
  collapsed: boolean
  count: number
}

export type StatusFilter = AgentSessionStatus | 'all'

// ---- Constants ----

const PAGE_SIZE = 30
const GROUP_ORDER = ['last3days', 'thisWeek', 'earlier'] as const
const GROUP_LABELS: Record<string, string> = {
  last3days: 'Last 3 Days',
  thisWeek: 'This Week',
  earlier: 'Earlier',
}

// ---- Time grouping helpers ----

function getTimeGroupKey(updatedAt: string): string {
  const diff = Date.now() - new Date(updatedAt).getTime()
  const h72 = 72 * 3600000
  const h168 = 168 * 3600000
  if (diff <= h72) return 'last3days'
  if (diff <= h168) return 'thisWeek'
  return 'earlier'
}

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

export function useSessionList() {
  const storeSessions = useDebugConsole(s => s.sessions)
  const storeRefresh = useDebugConsole(s => s.refreshSessions)
  const selectedSessionId = useDebugConsole(s => s.selectedSessionId)
  const panelOpen = useDebugConsole(s => s.panelOpen)
  const openPanel = useDebugConsole(s => s.openPanel)
  const deleteSession = useDebugConsole(s => s.deleteSession)
  const projectId = useDebugConsole(s => s.projectId)

  // Pagination state
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [countByStatus, setCountByStatus] = useState<Record<string, number>>({})
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Filter & search state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // Collapse state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['earlier']))
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  // ---- Derived: filtered + grouped ----

  const grouped = useMemo(() => {
    let list = storeSessions
    if (statusFilter !== 'all') list = list.filter(s => s.status === statusFilter)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(s => (s.title ?? s.prompt).toLowerCase().includes(q))
    }
    const tree = buildTree(list)
    const gm = new Map<string, SessionTreeNode[]>()
    for (const n of tree) {
      const gk = getTimeGroupKey(n.session.updatedAt)
      const a = gm.get(gk) ?? []
      a.push(n)
      gm.set(gk, a)
    }
    return GROUP_ORDER.filter(gk => gm.has(gk)).map(gk => ({
      key: gk,
      label: GROUP_LABELS[gk],
      sessions: gm.get(gk)!,
      collapsed: collapsedGroups.has(gk),
      count: gm.get(gk)!.length,
    }))
  }, [storeSessions, statusFilter, searchQuery, collapsedGroups])

  // ---- Derived: apply expand/collapse to tree nodes ----

  const visibleGroups = useMemo(() =>
    grouped.map(g => g.collapsed ? { ...g, sessions: [] } : {
      ...g,
      sessions: flattenTree(g.sessions.map(n => ({
        ...n,
        expanded: expandedNodes.has(n.session.id) ? true : n.expanded,
      }))),
    }),
  [grouped, expandedNodes])

  // ---- Actions ----

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    setPage(0)
    setHasMore(true)
    // Populate store sessions — needed for grouping to render
    await storeRefresh()
    try {
      // Fetch paginated counts for display
      const r = await agentRuntimeApi.listSessions({ projectId: projectId ?? undefined, limit: PAGE_SIZE, offset: 0 })
      setTotalCount(r.totalCount)
      setCountByStatus(r.countByStatus)
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
    totalCount,
    countByStatus,
    hasMore,
    isLoadingMore,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    selectedId: panelOpen ? selectedSessionId : null,
    select,
    refresh,
    loadMore,
    toggleGroup,
    toggleExpand,
    deleteSession,
  }
}
