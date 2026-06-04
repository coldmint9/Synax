import { memo } from 'react'
import { Chip } from '@heroui/react'
import { Trash2 } from 'lucide-react'
import type { SessionTreeNode } from './useSessionList'
import type { AgentSessionStatus } from '../../../lib/api/agentRuntime'

const STATUS_CHIP: Record<AgentSessionStatus, { color: 'primary' | 'success' | 'danger' | 'warning' | 'default'; label: string }> = {
  running: { color: 'primary', label: 'running' },
  waiting_permission: { color: 'warning', label: 'waiting' },
  blocked: { color: 'warning', label: 'blocked' },
  completed: { color: 'success', label: 'done' },
  failed: { color: 'danger', label: 'failed' },
  interrupted: { color: 'warning', label: 'interrupted' },
  paused: { color: 'default', label: 'paused' },
  queued: { color: 'default', label: 'queued' },
  cancelled: { color: 'default', label: 'cancelled' },
}

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

export const SessionTreeItem = memo(function SessionTreeItem({
  node, isSelected, onSelect, onToggleExpand, onDelete, onPause, onCancel,
}: Props) {
  const { session, depth, children } = node
  const hasKids = children.length > 0
  const isParent = depth === 0
  const chip = STATUS_CHIP[session.status] ?? { color: 'default' as const, label: session.status }

  return (
    <div
      className={`group cursor-pointer border-b border-border/20 transition-colors duration-150
        ${isSelected ? 'bg-accent/5 border-l-2 border-l-accent' : 'hover:bg-secondary/30 border-l-2 border-l-transparent'}`}
      style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: 12 }}
      onClick={() => onSelect(session.id)}
    >
      {isParent ? (
        <div className="py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              className="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground"
              onClick={e => { e.stopPropagation(); onToggleExpand(session.id) }}
              aria-label={node.expanded ? 'Collapse' : 'Expand'}
            >
              {hasKids ? (node.expanded ? '▾' : '▸') : <span className="w-3" />}
            </button>
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-slate-500'}`} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {session.title ?? session.prompt.slice(0, 50)}
            </span>
            <Chip size="sm" variant="soft" color={chip.color} className="h-4 text-[9px] shrink-0">
              {chip.label}
            </Chip>
            <DeleteButton sessionId={session.id} onDelete={onDelete} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-[10px] text-muted-foreground">
            {hasKids && <span>{children.length} sub-agent{children.length > 1 ? 's' : ''}</span>}
            {hasKids && <span>·</span>}
            <span>{relTime(session.updatedAt)}</span>
            {session.resultSummary && (
              <><span>·</span><span className="truncate max-w-[120px]">{session.resultSummary}</span></>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 py-1.5">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[session.status] ?? 'bg-slate-500'}`} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
            {session.title ?? session.prompt.slice(0, 50)}
          </span>
          {session.profileId && PROFILES[session.profileId] && (
            <Chip size="sm" variant="flat" className="h-3.5 text-[8px] text-muted-foreground shrink-0">
              {PROFILES[session.profileId]}
            </Chip>
          )}
          <span className="shrink-0 text-[9px] text-muted-foreground/70">{relTime(session.updatedAt)}</span>
        </div>
      )}
    </div>
  )
})
