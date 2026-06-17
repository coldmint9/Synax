import { useState } from 'react'
import { Chip } from '@heroui/react'
import { ChevronRight, ChevronDown, Clock } from 'lucide-react'
import type { ToolCallView } from './buildInterleavedTurns'
import { ToolCallSummaryLine } from './ToolCallSummaryLine'
import type { ToolCallBatch } from './toolCallUtils'

interface Props {
  batch: ToolCallBatch
}

function aggregateStatus(calls: ToolCallView[]): { label: string; color: 'accent' | 'success' | 'danger' | 'warning' | 'default' } {
  if (calls.some(c => c.status === 'failed')) return { label: 'failed', color: 'danger' }
  if (calls.some(c => c.status === 'running')) return { label: 'running', color: 'accent' }
  if (calls.some(c => c.status === 'denied')) return { label: 'denied', color: 'warning' }
  if (calls.every(c => c.status === 'completed')) return { label: 'completed', color: 'success' }
  return { label: 'pending', color: 'default' }
}

function maxDuration(calls: ToolCallView[]): string | null {
  const durations = calls.map(c => c.duration).filter(Boolean) as string[]
  return durations.length > 0 ? durations[durations.length - 1] : null
}

export function ToolCallBatchSummaryLine({ batch }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { calls, toolId } = batch
  const count = calls.length
  const status = aggregateStatus(calls)
  const duration = maxDuration(calls)
  const isSingle = count === 1

  if (isSingle) {
    return <ToolCallSummaryLine call={calls[0]} />
  }

  return (
    <div className="rounded-md border border-border/40 bg-background/30">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/20"
      >
        <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-primary">
          {count}×
        </span>
        <span className="shrink-0 font-mono text-[11px] font-medium text-foreground">
          {toolId}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {duration && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Clock size={9} className="shrink-0 text-muted-foreground" />
              {duration}
            </span>
          )}
          <Chip size="sm" color={status.color} variant="soft" className="h-4 text-[9px]">
            {status.label}
          </Chip>
          {expanded
            ? <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
            : <ChevronRight size={11} className="shrink-0 text-muted-foreground" />}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1 border-t border-border/30 p-1.5">
          {calls.map(call => (
            <ToolCallSummaryLine key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}
