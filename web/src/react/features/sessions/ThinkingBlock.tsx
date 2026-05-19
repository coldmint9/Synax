import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  content: string
}

export function ThinkingBlock({ content }: Props) {
  const [expanded, setExpanded] = useState(false)
  const preview = content.length > 120 ? content.slice(0, 120) + '...' : content

  return (
    <div className="rounded-md border border-border/30 bg-muted/20 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <Brain size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="text-[11px] font-medium text-muted-foreground/70">Thinking</span>
        {expanded
          ? <ChevronDown size={11} className="ml-auto text-muted-foreground/50" />
          : <ChevronRight size={11} className="ml-auto text-muted-foreground/50" />}
      </button>
      {expanded ? (
        <div className="mt-1.5 text-[12px] italic leading-relaxed text-muted-foreground/70 whitespace-pre-wrap">
          {content}
        </div>
      ) : (
        <div className="mt-1 text-[11px] italic text-muted-foreground/50 truncate">
          {preview}
        </div>
      )}
    </div>
  )
}
