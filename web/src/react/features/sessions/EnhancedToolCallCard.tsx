import { useState } from 'react'
import { Card, Chip } from '@heroui/react'
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

const STATUS_COLOR: Record<string, 'primary' | 'success' | 'danger' | 'warning' | 'default'> = {
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  denied: 'warning',
  cancelled: 'default',
  compacted: 'default',
}

export function EnhancedToolCallCard({ call }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [showFull, setShowFull] = useState(false)
  const Icon = getToolIcon(call.category)
  const hasOutput = Boolean(call.outputSummary)
  const outputText = call.outputSummary ?? ''
  const isLong = outputText.length > 800
  const chipColor = STATUS_COLOR[call.status] ?? 'default'

  return (
    <Card
      className={`shadow-none transition-colors animate-[fade-up_0.3s_ease-out] ${
        expanded ? 'border-accent/20 bg-accent/5' : 'border-border/60 bg-background/40'
      }`}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-mono text-xs font-semibold text-foreground">
          {call.toolId}
        </span>
        {call.inputSummary && (
          <span className="truncate text-xs text-muted-foreground">
            {call.inputSummary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {call.duration && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60">
              <Clock size={9} />
              {call.duration}
            </span>
          )}
          <Chip size="sm" color={chipColor} variant="flat" className="h-4 text-[9px]">
            {call.status}
          </Chip>
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
            {showFull || !isLong ? outputText : outputText.slice(0, 800) + '\n...'}
          </pre>
          {isLong && !showFull && (
            <button
              type="button"
              onClick={() => setShowFull(true)}
              className="mt-1 text-[10px] text-primary/70 hover:text-primary"
            >
              查看全部 ({Math.ceil(outputText.length / 1000)}k chars)
            </button>
          )}
        </div>
      )}
    </Card>
  )
}
