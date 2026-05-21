import { useState } from 'react'
import { ChevronDown, ChevronRight, FileEdit, FileSearch, Search, Terminal, Wrench } from 'lucide-react'
import type { ContextEntry } from '../../../lib/api/context'

interface Props {
  entry: ContextEntry
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  external_execution: Terminal,
  write: FileEdit,
  read: FileSearch,
  search: Search,
}

function getToolIcon(metadata: Record<string, unknown>) {
  const category = (metadata.category as string) ?? ''
  const mutability = (metadata.mutability as string) ?? ''
  if (category in TOOL_ICONS) return TOOL_ICONS[category]
  if (mutability === 'read') return FileSearch
  if (mutability === 'write') return FileEdit
  return Wrench
}

export function TranscriptEntry({ entry }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (entry.role === 'user') {
    return (
      <div className="group border-l-2 border-primary/50 py-1.5 pl-3 pr-2">
        <div className="flex items-start gap-2">
          <span className="shrink-0 font-bold text-primary">❯</span>
          <span className="whitespace-pre-wrap text-foreground">{entry.content}</span>
        </div>
      </div>
    )
  }

  if (entry.role === 'assistant') {
    return (
      <div className="py-1.5 pl-3 pr-2">
        <div className="whitespace-pre-wrap text-foreground/90">
          {entry.content}
        </div>
      </div>
    )
  }

  if (entry.role === 'tool' && entry.contentType === 'tool_call') {
    const Icon = getToolIcon(entry.metadata)
    const toolId = (entry.metadata.toolId as string) ?? 'tool'
    const inputSummary = (entry.metadata.inputSummary as string) ?? entry.content.slice(0, 80)

    return (
      <div className="py-0.5 pl-3 pr-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-secondary/40"
        >
          {expanded
            ? <ChevronDown size={10} className="shrink-0 text-muted-foreground/60" />
            : <ChevronRight size={10} className="shrink-0 text-muted-foreground/60" />}
          <Icon size={11} className="shrink-0 text-muted-foreground" />
          <span className="font-bold text-foreground/70">{toolId}</span>
          {inputSummary && (
            <span className="truncate text-muted-foreground">{inputSummary}</span>
          )}
        </button>
        {expanded && entry.content && (
          <div className="ml-5 mt-0.5 rounded border border-border/50 bg-background/80 p-2">
            <pre className="whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
              {entry.content.length > 800 ? entry.content.slice(0, 800) + '\n...' : entry.content}
            </pre>
          </div>
        )}
      </div>
    )
  }

  if (entry.role === 'tool' && entry.contentType === 'tool_result') {
    return (
      <div className="py-0.5 pl-3 pr-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-secondary/40"
        >
          {expanded
            ? <ChevronDown size={10} className="shrink-0 text-muted-foreground/60" />
            : <ChevronRight size={10} className="shrink-0 text-muted-foreground/60" />}
          <span className="text-muted-foreground/70">⏎ result</span>
          <span className="truncate text-muted-foreground">{entry.content.slice(0, 60)}</span>
        </button>
        {expanded && (
          <div className="ml-5 mt-0.5 rounded border border-border/50 bg-background/80 p-2">
            <pre className="whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
              {entry.content.length > 800 ? entry.content.slice(0, 800) + '\n...' : entry.content}
            </pre>
          </div>
        )}
      </div>
    )
  }

  if (entry.role === 'system') {
    return (
      <div className="py-0.5 pl-3 pr-2">
        <span className="text-[10px] italic text-muted-foreground/60">{entry.content.slice(0, 100)}</span>
      </div>
    )
  }

  // Fallback for other roles/types
  return (
    <div className="py-0.5 pl-3 pr-2">
      <span className="text-muted-foreground">{entry.content.slice(0, 200)}</span>
    </div>
  )
}
