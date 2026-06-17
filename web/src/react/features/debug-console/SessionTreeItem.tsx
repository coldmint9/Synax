import type { AgentSession, AgentSessionStatus } from '../../../lib/api/agentRuntime'
import type { SessionTreeNode } from '../sessions/sessionGrouping'
import { getSessionDisplayTitle } from '../sessions/useSessionDisplayTitle'

interface Props {
  node: SessionTreeNode
  depth?: number
  selectedId: string | null
  onSelect: (sessionId: string) => void
}

const STATUS_DOT: Record<AgentSessionStatus, string> = {
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

export function SessionTreeItem({ node, depth = 0, selectedId, onSelect }: Props) {
  const { session } = node
  const active = session.id === selectedId

  return (
    <>
      <li
        className={`list-row ${active ? 'list-row--active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(session.id)}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[session.status] ?? 'bg-muted-foreground/30'}`} />
          <span className="truncate font-medium" title={getSessionDisplayTitle(session)}>
            {getSessionDisplayTitle(session).slice(0, 40)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[9px] text-muted-foreground">
          <span>{session.status}</span>
          {session.model && <span className="font-mono">{session.model}</span>}
        </div>
      </li>
      {node.children.map(child => (
        <SessionTreeItem
          key={child.session.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}
