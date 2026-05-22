import { Bot, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { AgentSession } from '../../../lib/api/agentRuntime'
import { getSessionCategory } from './sessionGrouping'

interface Props {
  session: AgentSession
  onExpand?: (sessionId: string) => void
}

const STATUS_DOT: Record<string, string> = {
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

export function SubSessionCard({ session, onExpand }: Props) {
  const [expanded, setExpanded] = useState(false)
  const cat = getSessionCategory(session.profileId)

  return (
    <div className="rounded-lg border border-border/50 bg-secondary/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Bot size={12} className="shrink-0 text-muted-foreground/70" />
        <span className="rounded border border-border/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {session.profileId}
        </span>
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[session.status] ?? ''}`} />
        <span className="truncate text-xs text-muted-foreground">
          {session.prompt.slice(0, 60)}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {onExpand && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onExpand(session.id) }}
              className="text-[10px] text-primary/70 hover:text-primary"
            >
              详情
            </button>
          )}
          {expanded
            ? <ChevronDown size={11} className="text-muted-foreground/50" />
            : <ChevronRight size={11} className="text-muted-foreground/50" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 text-[11px] text-muted-foreground">
          {session.resultSummary ? (
            <p className="whitespace-pre-wrap leading-relaxed">{session.resultSummary}</p>
          ) : session.status === 'running' ? (
            <p className="italic">执行中...</p>
          ) : (
            <p className="italic">暂无结果</p>
          )}
        </div>
      )}
    </div>
  )
}
