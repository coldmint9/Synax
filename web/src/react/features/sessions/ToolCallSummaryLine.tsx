import { useState } from 'react'
import { Chip } from '@heroui/react'
import { Terminal, FileEdit, FileSearch, Search, Wrench, GitBranch, ChevronRight, ChevronDown, Clock } from 'lucide-react'
import type { ToolCallView } from './buildInterleavedTurns'

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
  task: GitBranch,
}

function getToolIcon(category: string) {
  return TOOL_ICONS[category] ?? Wrench
}

const STATUS_COLOR: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'default'> = {
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  denied: 'warning',
  cancelled: 'default',
  compacted: 'default',
  pending: 'default',
}

function truncate(text: string, max = 72): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function ToolCallSummaryLine({ call }: Props) {
  const [expanded, setExpanded] = useState(false)
  const Icon = getToolIcon(call.category)
  const chipColor = STATUS_COLOR[call.status] ?? 'default'
  const hasDetails = Boolean(call.inputSummary || call.outputSummary)

  return (
    <div className="rounded-md border border-border/40 bg-background/30">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/20"
      >
        <Icon size={11} className="shrink-0 text-primary" />
        <span className="shrink-0 font-mono text-[11px] font-medium text-foreground">
          {call.toolId}
        </span>
        {call.inputSummary && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {truncate(call.inputSummary)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {call.duration && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Clock size={9} className="shrink-0 text-muted-foreground" />
              {call.duration}
            </span>
          )}
          <Chip size="sm" color={chipColor} variant="soft" className="h-4 text-[9px]">
            {call.status}
          </Chip>
          {hasDetails && (
            expanded
              ? <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
              : <ChevronRight size={11} className="shrink-0 text-muted-foreground" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border/30 px-2.5 py-2">
          {call.inputSummary && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">Input</div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                {call.inputSummary}
              </pre>
            </div>
          )}
          {call.outputSummary && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">Output</div>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                {call.outputSummary}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
