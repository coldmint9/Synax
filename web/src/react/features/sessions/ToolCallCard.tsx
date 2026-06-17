import { useState } from 'react'
import { Terminal, FileEdit, FileSearch, Search, Wrench, ChevronRight, ChevronDown } from 'lucide-react'
import type { ToolCallView } from './buildConversationTurns'

interface Props {
  call: ToolCallView
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  external_execution: Terminal,
  shell: Terminal,
  write: FileEdit,
  read: FileSearch,
  search: Search,
  context: Search,
}

function getToolIcon(category: string) {
  return TOOL_ICONS[category] ?? Wrench
}

export function ToolCallCard({ call }: Props) {
  const [expanded, setExpanded] = useState(false)
  const Icon = getToolIcon(call.category)
  const hasOutput = Boolean(call.outputSummary)

  return (
    <div
      className={`rounded-lg border transition-colors ${
        expanded ? 'border-accent/20 bg-accent/5' : 'border-border/60 bg-background/40'
      }`}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon size={13} className="shrink-0 text-primary" />
        <span className="shrink-0 font-mono text-xs font-semibold text-foreground">
          {call.toolId}
        </span>
        {call.inputSummary && (
          <span className="truncate text-xs text-muted-foreground">
            {call.inputSummary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {call.status === 'failed' && (
            <span className="text-[10px] font-medium text-destructive">failed</span>
          )}
          {call.status === 'running' && (
            <span className="text-[10px] font-medium text-[var(--color-agent)]">running</span>
          )}
          {hasOutput && (
            expanded
              ? <ChevronDown size={12} className="text-muted-foreground" />
              : <ChevronRight size={12} className="text-muted-foreground" />
          )}
        </span>
      </button>

      {expanded && call.outputSummary && (
        <div className="border-t border-border/40 px-3 pb-2.5 pt-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
            {call.outputSummary.length > 800
              ? call.outputSummary.slice(0, 800) + '\n...'
              : call.outputSummary}
          </pre>
        </div>
      )}
    </div>
  )
}