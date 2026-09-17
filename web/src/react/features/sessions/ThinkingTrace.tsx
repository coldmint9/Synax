import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

// Transcript virtualization unmounts rows. Keep explicit reader choices across remounts.
const expandedTraces = new Map<string, boolean>()
const REVEAL_MS = 400

export function ThinkingGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
  </svg>
}

interface Props {
  label: string
  working?: boolean
  icon?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  rememberKey?: string
  title?: string
  meta?: string | null
  maxHeight?: string | number
  variant?: 'reasoning' | 'steps' | 'coding' | 'search'
}

/** A real-event-driven ThinkingState: animation never decides whether work is done. */
export function ThinkingTrace({
  label, working = false, icon, children, footer, rememberKey, title, meta,
  maxHeight = 140, variant = 'reasoning',
}: Props) {
  const [manual, setManual] = useState<boolean | null>(() =>
    rememberKey ? expandedTraces.get(rememberKey) ?? null : null,
  )
  useEffect(() => {
    setManual(rememberKey ? expandedTraces.get(rememberKey) ?? null : null)
  }, [rememberKey])
  const hasBody = Boolean(children)
  const expanded = hasBody && (manual ?? working)
  const [retained, setRetained] = useState(expanded)
  const bodyId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)

  // Keep the bounded body during the closing transition, then release it.
  useEffect(() => {
    if (expanded) {
      setRetained(true)
      return
    }
    if (!retained) return
    const timer = window.setTimeout(() => setRetained(false), REVEAL_MS)
    return () => window.clearTimeout(timer)
  }, [expanded, retained])

  // Reasoning is read newest-first: opening a row lands on the latest record
  // instead of the oldest one, and a live row keeps following as it grows.
  useEffect(() => {
    if (expanded && variant === 'reasoning' && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [children, working, expanded, variant])

  const heading = <>
    <span className="bui-thinking-symbol">{icon ?? <ThinkingGlyph />}</span>
    <span role="status" className="bui-thinking-label" key={String(working)}>{label}</span>
    {meta && <span className="bui-thinking-meta">{meta}</span>}
    {hasBody && <ChevronDown size={14} className="bui-thinking-chevron" aria-hidden="true" />}
  </>

  return <div className="bui-thinking" data-live={working || undefined} data-expanded={expanded} data-variant={variant}>
    {hasBody ? <button
      type="button"
      className="bui-thinking-trigger"
      aria-expanded={expanded}
      aria-controls={bodyId}
      title={title}
      onClick={() => {
        const next = !expanded
        setManual(next)
        if (rememberKey) expandedTraces.set(rememberKey, next)
      }}
    >{heading}</button> : <div className="bui-thinking-trigger" title={title}>{heading}</div>}
    {hasBody && <div className="bui-thinking-reveal" id={bodyId} aria-hidden={!expanded} inert={!expanded}>
      <div className="bui-thinking-clip">
        {(expanded || retained) && <div className="bui-thinking-trace">
          <div ref={bodyRef} data-activity-body="" className="bui-thinking-body session-work-log-body" style={{ maxHeight }}>
            {children}
          </div>
          {expanded && footer}
        </div>}
      </div>
    </div>}
  </div>
}
