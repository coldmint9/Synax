import { memo } from 'react'
import { Trash2 } from 'lucide-react'
import type { SessionTreeNode } from './useSessionList'
import { isSessionUnread, useAgentSessionStore } from './agentSessionStore'
import { useSessionDisplayTitle } from './useSessionDisplayTitle'
import { isSynaxSession, resolveSynaxAgentLabel } from './synaxDisplay'

const DOT: Record<string, string> = {
  running: 'bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.5)]',
  completed: 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]',
  failed: 'bg-red-500',
  waiting_permission: 'bg-amber-500',
  blocked: 'bg-amber-500',
  interrupted: 'bg-amber-400',
  paused: 'bg-sky-400',
  queued: 'bg-slate-500',
  cancelled: 'bg-slate-600',
}

const PROFILES: Record<string, string> = {
  'wiki-planner': 'Planner',
  'wiki-writer': 'Writer',
  'wiki-explorer': 'Explorer',
  'wiki-generator': 'Generator',
  explorer: 'Explorer',
  reviewer: 'Reviewer',
}

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

interface Props {
  node: SessionTreeNode
  isSelected: boolean
  onSelect: (id: string) => void
  onToggleExpand: (id: string) => void
  onDelete?: (id: string) => void
  onPause?: (id: string) => void
  onCancel?: (id: string) => void
}

function DeleteButton({ sessionId, onDelete }: { sessionId: string; onDelete?: (id: string) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex items-center justify-center h-5 w-5 min-w-0 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-danger/70 hover:text-danger hover:bg-danger/10 cursor-pointer"
      aria-label="Delete session"
      onClick={(e) => { e.stopPropagation(); onDelete?.(sessionId) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDelete?.(sessionId) } }}
    >
      <Trash2 size={13} />
    </span>
  )
}

function SessionTitle({ session }: { session: SessionTreeNode['session'] }) {
  const title = useSessionDisplayTitle(session)
  return (
    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
      {title}
    </span>
  )
}

function SessionChildTitle({ session }: { session: SessionTreeNode['session'] }) {
  const title = useSessionDisplayTitle(session)
  return (
    <span className="min-w-0 flex-1 truncate text-[11px]">
      {title}
    </span>
  )
}

export const SessionTreeItem = memo(function SessionTreeItem({
  node, isSelected, onSelect, onToggleExpand, onDelete, onPause, onCancel,
}: Props) {
  const { session, depth, children } = node
  const hasKids = children.length > 0
  const isParent = depth === 0
  const readMarkers = useAgentSessionStore(s => s.readSessionMarkers)
  const showStatusDot = isSessionUnread(session, readMarkers)

  const shellClass = isParent
    ? `list-card group ${isSelected ? 'list-card--active' : ''}`
    : `list-row group ${isSelected ? 'list-row--active' : ''}`

  return (
    <div
      className={shellClass}
      style={{ marginLeft: `${depth * 12}px`, marginRight: 6 }}
      onClick={() => onSelect(session.id)}
    >
      {isParent ? (
        <>
          <div className="flex items-center gap-1.5">
            <button
              className="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground"
              onClick={e => { e.stopPropagation(); onToggleExpand(session.id) }}
              aria-label={node.expanded ? 'Collapse' : 'Expand'}
            >
              {hasKids ? (node.expanded ? '\u25BE' : '\u25B8') : <span className="w-3" />}
            </button>
            {showStatusDot && (
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-slate-500'}`} />
            )}
            <SessionTitle session={session} />
            <span className="shrink-0 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
              {relTime(session.updatedAt)}
            </span>
            <DeleteButton sessionId={session.id} onDelete={onDelete} />
          </div>
        </>
      ) : (
        <>
          {/* Dot: only show when active */}
          {isSelected && (
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-slate-500'}`} />
          )}
          <SessionChildTitle session={session} />
          {isSelected && session.profileId && !isSynaxSession(session) && PROFILES[session.profileId] && (
            <span className="list-badge">{PROFILES[session.profileId]}</span>
          )}
          {isSelected && isSynaxSession(session) ? (
            <span className="list-badge">{resolveSynaxAgentLabel(session)}</span>
          ) : null}
          <span className="shrink-0 text-[9px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
            {relTime(session.updatedAt)}
          </span>
        </>
      )}
    </div>
  )
})
