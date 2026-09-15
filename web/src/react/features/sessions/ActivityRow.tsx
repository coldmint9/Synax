import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

const expandedRows = new Map<string, boolean>()
const BODY_MAX_HEIGHT = 140

interface Props {
  icon?: ReactNode
  label: string
  meta?: string | null
  preview?: string | null
  body?: string | null
  bodyContent?: ReactNode
  footnote?: string | null
  bodyMaxHeight?: number
  live?: boolean
  rememberKey?: string
}

export const ActivityRow = memo(function ActivityRow({ icon, label, meta, preview, body, bodyContent, footnote, bodyMaxHeight = BODY_MAX_HEIGHT, live = false, rememberKey }: Props) {
  const [expanded, setExpanded] = useState(() => (rememberKey ? expandedRows.get(rememberKey) ?? false : false))
  const bodyRef = useRef<HTMLDivElement>(null)
  const hasBody = Boolean(body) || Boolean(bodyContent)
  useEffect(() => {
    if (live) return
    setExpanded(rememberKey ? expandedRows.get(rememberKey) ?? false : false)
  }, [live, rememberKey])
  useEffect(() => {
    if (!live && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [live, body])
  const isOpen = live || expanded
  const interactive = !live && hasBody
  const toggle = useCallback(() => {
    if (!hasBody) return
    setExpanded(previous => {
      const next = !previous
      if (rememberKey) expandedRows.set(rememberKey, next)
      return next
    })
  }, [hasBody, rememberKey])

  return (
    <div className="group/activity flex min-w-0 flex-col">
      {interactive ? (
        <button type="button" onClick={toggle} aria-expanded={isOpen} className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-primary/15 bg-primary/[0.045] px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.08]">
          <span className="shrink-0 text-primary transition-transform duration-300">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="shrink-0 text-xs font-semibold text-primary">{label}</span>
          {meta ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">{meta}</span> : null}
          {preview && !isOpen ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/50">{preview}</span> : null}
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {icon}<span className={`shrink-0 text-[11px] ${live ? 'animate-pulse text-muted-foreground/80' : 'text-muted-foreground/60'}`}>{label}</span>
          {meta ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">{meta}</span> : null}
          {preview ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/40">{preview}</span> : null}
        </div>
      )}
      {isOpen && hasBody ? (
        <div ref={bodyRef} data-activity-body="" style={{ maxHeight: bodyMaxHeight }} className={`session-work-log-body ms-2 mt-1 overflow-y-auto break-words text-[11px] leading-relaxed ${body ? 'whitespace-pre-wrap italic text-muted-foreground/60' : ''}`}>
          {bodyContent ?? body}
          {footnote ? <div className="mt-1 not-italic text-[10px] text-muted-foreground/35">{footnote}</div> : null}
        </div>
      ) : null}
    </div>
  )
})
