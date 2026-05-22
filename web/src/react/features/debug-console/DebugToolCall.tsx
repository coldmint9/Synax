import { useState } from 'react'
import { Terminal, FileEdit, FileSearch, Search, Wrench, ChevronRight, ChevronDown } from 'lucide-react'
import type { RuntimeEvent } from '../../../lib/api/agentRuntime'

interface Props {
  event: RuntimeEvent
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  external_execution: Terminal,
  write: FileEdit,
  read: FileSearch,
  search: Search,
}

function getToolIcon(payload: Record<string, unknown>) {
  const category = (payload.category as string) ?? ''
  const mutability = (payload.mutability as string) ?? ''
  if (category in TOOL_ICONS) return TOOL_ICONS[category]
  if (mutability === 'read') return FileSearch
  if (mutability === 'write') return FileEdit
  return Wrench
}

export function DebugToolCall({ event }: Props) {
  const [expanded, setExpanded] = useState(false)
  const payload = event.payload as Record<string, unknown>
  const toolId = (payload.toolId as string) ?? 'tool'
  const inputSummary = (payload.inputSummary as string) ?? ''
  const outputSummary = (payload.outputSummary as string) ?? ''
  const status = (payload.status as string) ?? ''
  const Icon = getToolIcon(payload)

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-secondary/40"
      >
        {expanded
          ? <ChevronDown size={10} className="shrink-0 text-muted-foreground/60" />
          : <ChevronRight size={10} className="shrink-0 text-muted-foreground/60" />
        }
        <Icon size={11} className="shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium text-foreground/80">{toolId}</span>
        {inputSummary && (
          <span className="truncate text-muted-foreground">{inputSummary}</span>
        )}
        {status === 'failed' && (
          <span className="text-[10px] text-danger">failed</span>
        )}
      </button>

      {expanded && outputSummary && (
        <div className="ml-5 mt-0.5 rounded border border-border/50 bg-background/80 p-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
            {outputSummary.length > 500
              ? outputSummary.slice(0, 500) + '\n...'
              : outputSummary}
          </pre>
        </div>
      )}
    </div>
  )
}
