import { memo, useRef } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { SessionTreeNode } from './useSessionList'
import { isSessionUnread, useAgentSessionStore } from './agentSessionStore'
import { useSessionDisplayTitle } from './useSessionDisplayTitle'
import { isSynaxSession, resolveSynaxAgentLabel } from './synaxDisplay'

const DOT: Record<string, string> = {
  running: 'bg-run shadow-[0_0_6px_color-mix(in_srgb,var(--run)_50%,transparent)]',
  completed: 'bg-success shadow-[0_0_6px_color-mix(in_srgb,var(--success)_40%,transparent)]',
  failed: 'bg-destructive',
  waiting_permission: 'bg-warning',
  blocked: 'bg-warning',
  interrupted: 'bg-warning/60',
  paused: 'bg-muted-foreground',
  queued: 'bg-muted-foreground/60',
  cancelled: 'bg-muted-foreground/40',
}

const PROFILES: Record<string, string> = {
  'wiki-planner': 'Planner',
  'wiki-writer': 'Writer',
  'wiki-explorer': 'Explorer',
  'wiki-generator': 'Generator',
  explorer: 'Explorer',
  reviewer: 'Reviewer',
}

type Translator = ReturnType<typeof useLocale>['t']

function relTime(iso: string, t: Translator): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return t('timeMinutesAgo', { count: m })
  if (m < 1440) return t('timeHoursAgo', { count: Math.floor(m / 60) })
  return t('timeDaysAgo', { count: Math.floor(m / 1440) })
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
  const { t } = useLocale()
  return (
    <span
      role="button"
      tabIndex={0}
      className="session-list-delete inline-flex items-center justify-center h-5 w-5 min-w-0 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-danger/70 hover:text-danger hover:bg-danger/10 cursor-pointer"
      aria-label={t('sessionDelete')}
      onClick={(e) => { e.stopPropagation(); onDelete?.(sessionId) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDelete?.(sessionId) } }}
    >
      <Trash2 size={13} />
    </span>
  )
}

function SessionTitle({ session }: { session: SessionTreeNode['session'] }) {
  const title = useSessionDisplayTitle(session)
  const ref = useRef<HTMLSpanElement>(null)
  return (
    <span
      ref={ref}
      title={title}
      className="session-list-title min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left text-[13px] font-medium text-foreground"
      onMouseEnter={() => ref.current?.scrollTo({ left: ref.current.scrollWidth, behavior: 'smooth' })}
      onMouseLeave={() => ref.current?.scrollTo({ left: 0, behavior: 'smooth' })}
    >
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
  const { t } = useLocale()
  const { session, depth, children } = node
  const hasKids = children.length > 0
  const isParent = depth === 0
  const isRunning = session.status === 'running'
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
              aria-label={t(node.expanded ? 'sessionCollapse' : 'sessionExpand')}
            >
              {hasKids ? (node.expanded ? '\u25BE' : '\u25B8') : <span className="w-3" />}
            </button>
            {isRunning ? (
              <Loader2
                size={10}
                className="session-list-running-indicator animate-spin text-[var(--color-run)]"
                aria-hidden
              />
            ) : showStatusDot ? (
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-muted-foreground/50'}`} />
            ) : null}
            <SessionTitle session={session} />
            <span className="session-list-hover-actions inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity">
              <span>{relTime(session.updatedAt, t)}</span>
              <DeleteButton sessionId={session.id} onDelete={onDelete} />
            </span>
          </div>
        </>
      ) : (
        <>
          {/* Spinner while running (out of flow, leading gutter); dot only when selected */}
          {isRunning ? (
            <Loader2
              size={10}
              className="session-list-running-indicator session-list-running-indicator--child animate-spin text-[var(--color-run)]"
              aria-hidden
            />
          ) : isSelected ? (
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-muted-foreground/50'}`} />
          ) : null}
          <SessionChildTitle session={session} />
          {isSelected && session.profileId && !isSynaxSession(session) && PROFILES[session.profileId] && (
            <span className="list-badge">{PROFILES[session.profileId]}</span>
          )}
          {isSelected && isSynaxSession(session) ? (
            <span className="list-badge">{resolveSynaxAgentLabel(session)}</span>
          ) : null}
          <span className="shrink-0 text-[9px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
            {relTime(session.updatedAt, t)}
          </span>
        </>
      )}
    </div>
  )
})
