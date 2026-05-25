// ---------------------------------------------------------------------------
// Unified Session Panel — merges context sessions and agent sessions into one
// list with context/agent-specific selection and deletion flows.
// Sub-agents are nested under their parent session with indentation.
// ---------------------------------------------------------------------------

import { Activity, AlertTriangle, Clock, MessageSquare, Plus, RefreshCw, Trash2, Bot } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useContextStore } from '../../state/contextStore'
import { useDebugConsole } from '../debug-console/debugConsoleStore'
import { useDebugPolling } from '../debug-console/useDebugPolling'
import type { AgentSession, AgentSessionStatus } from '../../../lib/api/agentRuntime'

const AGENT_STATUS_DOT: Record<AgentSessionStatus, string> = {
  running: 'bg-[var(--color-run)] animate-pulse',
  waiting_permission: 'bg-warning',
  blocked: 'bg-warning',
  completed: 'bg-success',
  failed: 'bg-danger',
  interrupted: 'bg-amber-400',
  paused: 'bg-sky-400',
  queued: 'bg-muted-foreground/50',
  cancelled: 'bg-muted-foreground/30',
}

interface UnifiedSession {
  id: string
  kind: 'context' | 'agent'
  label: string
  profileLabel: string | null
  status: string
  dotClass: string
  entryCount: number
  tokenCount: number
  updatedAt: string
  sourceAgent: string | null
  depth: number
  children: UnifiedSession[]
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

const PROFILE_LABELS: Record<string, string> = {
  'wiki-planner': 'Planner',
  'wiki-writer': 'Writer',
  'wiki-explorer': 'Explorer',
  'wiki-generator': 'Generator',
  explorer: 'Explorer',
  reviewer: 'Reviewer',
}

function buildAgentTree(sessions: AgentSession[], depth = 0): UnifiedSession[] {
  const topLevel = sessions.filter(s => !s.parentSessionId)
  const childMap = new Map<string, AgentSession[]>()
  for (const s of sessions) {
    if (s.parentSessionId) {
      const arr = childMap.get(s.parentSessionId) ?? []
      arr.push(s)
      childMap.set(s.parentSessionId, arr)
    }
  }

  function toNode(s: AgentSession, d: number): UnifiedSession {
    const kids = (childMap.get(s.id) ?? [])
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map(child => toNode(child, d + 1))
    return {
      id: s.id,
      kind: 'agent',
      label: (s.title ?? s.prompt).slice(0, 50),
      profileLabel: PROFILE_LABELS[s.profileId] ?? s.profileId,
      status: s.status,
      dotClass: AGENT_STATUS_DOT[s.status] ?? 'bg-muted-foreground/40',
      entryCount: 0,
      tokenCount: 0,
      updatedAt: s.updatedAt,
      sourceAgent: null,
      depth: d,
      children: kids,
    }
  }

  return topLevel
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(s => toNode(s, depth))
}

function flattenNodes(nodes: UnifiedSession[]): UnifiedSession[] {
  const result: UnifiedSession[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.children.length > 0) {
      result.push(...flattenNodes(node.children))
    }
  }
  return result
}

export default function SessionList() {
  useDebugPolling()

  const projectId = useContextStore((s) => s.projectId) ?? ''
  const navigate = useNavigate()

  // Context sessions
  const ctxSessions = useContextStore((s) => s.sessions)
  const currentSessionId = useContextStore((s) => s.currentSessionId)
  const syncStatus = useContextStore((s) => s.syncStatus)
  const tokenWarnings = useContextStore((s) => s.tokenWarnings)
  const loading = useContextStore((s) => s.loading.sessions)
  const refresh = useContextStore((s) => s.refreshSessions)
  const selectCtx = useContextStore((s) => s.selectSession)
  const deleteCtx = useContextStore((s) => s.deleteSession)
  const create = useContextStore((s) => s.createOrResumeSession)

  // Agent sessions
  const agentSessions = useDebugConsole((s) => s.sessions)
  const selectedAgentId = useDebugConsole((s) => s.selectedSessionId)
  const agentPanelOpen = useDebugConsole((s) => s.panelOpen)
  const openAgentPanel = useDebugConsole((s) => s.openPanel)
  const closeAgentPanel = useDebugConsole((s) => s.closePanel)
  const deleteAgent = useDebugConsole((s) => s.deleteSession)

  const [busy, setBusy] = useState(false)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  // Merge into unified list: context sessions flat + agent sessions as tree
  const unified = useMemo<UnifiedSession[]>(() => {
    const ctx: UnifiedSession[] = ctxSessions.map((s) => ({
      id: s.id,
      kind: 'context',
      label: s.title ?? s.id.slice(-8),
      profileLabel: null,
      status: s.status,
      dotClass: 'bg-primary/60',
      entryCount: s.entryCount,
      tokenCount: s.tokenCount,
      updatedAt: s.updatedAt,
      sourceAgent: s.sourceAgent,
      depth: 0,
      children: [],
    }))
    const agentTree = buildAgentTree(agentSessions)
    const topLevel = [...ctx, ...agentTree].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    return flattenNodes(topLevel)
  }, [ctxSessions, agentSessions])

  // PLACEHOLDER_HANDLERS
  const handleNew = async () => {
    setBusy(true)
    try { await create('web') } finally { setBusy(false) }
  }

  const handleSelect = (s: UnifiedSession) => {
    if (s.kind === 'context') {
      closeAgentPanel()
      void selectCtx(s.id)
    } else {
      openAgentPanel(s.id)
    }
    navigate(`/projects/${projectId}/sessions`)
  }

  const handleDelete = async (s: UnifiedSession, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const confirmMessage = s.kind === 'agent'
      ? `删除 agent 会话「${s.label}」？这会中断当前运行，并删除其事件、消息、步骤和子会话。`
      : `删除会话「${s.label}」？此操作不可撤销。`
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(confirmMessage)
      if (!confirmed) return
    }
    setDeletingIds(prev => new Set(prev).add(s.id))
    try {
      if (s.kind === 'agent') {
        await deleteAgent(s.id)
      } else {
        await deleteCtx(s.id)
      }
    } catch (err) {
      if (typeof window !== 'undefined') {
        const message = err instanceof Error ? err.message : '删除会话失败'
        window.alert(message)
      }
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(s.id)
        return next
      })
    }
  }

  const syncDot =
    syncStatus === 'connected' ? 'bg-success'
    : syncStatus === 'connecting' ? 'bg-warning animate-pulse'
    : syncStatus === 'error' ? 'bg-destructive'
    : 'bg-muted-foreground/40'

  const warning = currentSessionId ? tokenWarnings[currentSessionId] : undefined

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Status bar */}
      <div className="flex items-center justify-between border-b border-border/40 px-2 py-1.5">
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${syncDot}`} />
          <span>{unified.length} sessions</span>
          {warning && (
            <span className="flex items-center gap-0.5 text-warning">
              <AlertTriangle size={9} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Refresh"
            disabled={loading}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/agent-loop-test')}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Agent Loop"
            title="Agent Loop Test"
          >
            <Bot size={12} />
          </button>
          <button
            type="button"
            onClick={() => void handleNew()}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            aria-label="New session"
            disabled={busy}
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      {/* Unified session list */}
      <div className="flex-1 overflow-y-auto">
        {unified.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            无活跃会话
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {unified.map((s) => {
              const isActive =
                (s.kind === 'context' && s.id === currentSessionId) ||
                (s.kind === 'agent' && s.id === selectedAgentId && agentPanelOpen)
              const isChild = s.depth > 0
              return (
                <li
                  key={`${s.kind}-${s.id}`}
                  className={`group cursor-pointer py-1.5 transition ${
                    isActive ? 'bg-primary/10 text-foreground' : 'hover:bg-secondary/40'
                  } ${isChild ? 'bg-secondary/10' : ''}`}
                  style={{ paddingLeft: `${8 + s.depth * 16}px`, paddingRight: 8 }}
                  onClick={() => handleSelect(s)}
                >
                  <div className="flex items-center gap-2">
                    <span className={`inline-block shrink-0 rounded-full ${s.dotClass} ${isChild ? 'h-1 w-1' : 'h-1.5 w-1.5'}`} />
                    {isChild && <span className="text-[9px] text-muted-foreground/50">↳</span>}
                    <span className={`min-w-0 flex-1 truncate ${isChild ? 'text-[11px] text-muted-foreground' : 'font-medium'}`} title={s.label}>
                      {s.label}
                    </span>
                    {isChild && s.profileLabel && (
                      <span className="shrink-0 rounded bg-secondary/60 px-1 py-px text-[8px] text-muted-foreground/70">
                        {s.profileLabel}
                      </span>
                    )}
                    {!isChild && (
                      <span className="shrink-0 rounded bg-secondary/60 px-1 py-px text-[8px] uppercase text-muted-foreground">
                        {s.kind === 'context' ? 'ctx' : 'agent'}
                      </span>
                    )}
                    {!isChild && (
                      <button
                        type="button"
                        onPointerDown={(e) => { e.stopPropagation() }}
                        onMouseDown={(e) => { e.stopPropagation() }}
                        onClick={(e) => void handleDelete(s, e)}
                        className={`shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive ${
                          deletingIds.has(s.id) ? 'opacity-50' : 'opacity-70 group-hover:opacity-100 focus:opacity-100'
                        }`}
                        aria-label="Delete session"
                        title={s.kind === 'agent' ? '删除 agent 会话' : '删除'}
                        disabled={deletingIds.has(s.id)}
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                  <div className={`mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground ${isChild ? 'pl-5' : 'pl-3.5'}`}>
                    <span>{s.status}</span>
                    {s.kind === 'context' && (
                      <>
                        <span className="flex items-center gap-0.5">
                          <MessageSquare size={8} />
                          {s.entryCount}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Activity size={8} />
                          {s.tokenCount}
                        </span>
                      </>
                    )}
                    <span className="flex items-center gap-0.5">
                      <Clock size={8} />
                      {fmtTime(s.updatedAt)}
                    </span>
                    {s.sourceAgent && (
                      <span className="rounded bg-secondary px-1 py-px font-mono">
                        {s.sourceAgent}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
