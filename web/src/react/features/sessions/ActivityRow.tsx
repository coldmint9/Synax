import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * Expand state deliberately lives outside React: transcript rows unmount when
 * they scroll out of the lazy window, and a reader who opened one activity row
 * should not have to open it again after scrolling back.
 */
const expandedRows = new Map<string, boolean>()

/**
 * Body cap, mirroring the ~8.75rem window Codex gives a reasoning body. A raw
 * reasoning block can be 50k+ characters, which must never be laid out whole.
 */
const BODY_MAX_HEIGHT = 140

interface Props {
  icon?: ReactNode
  label: string
  /** Right-aligned dim metadata, e.g. the character count. */
  meta?: string | null
  /** One-line teaser shown while collapsed. */
  preview?: string | null
  /** Full text. Mounted only while expanded — this is what keeps rows cheap. */
  body?: string | null
  /** Rich body, used instead of `body` when a row expands into nested content. */
  bodyContent?: ReactNode
  /** Dim note rendered under an expanded body, e.g. how much text was elided. */
  footnote?: string | null
  /** Expanded height cap; rows that open a nested list need more room. */
  bodyMaxHeight?: number
  /** Streaming row: badge label, body always mounted and scrolled to the end. */
  live?: boolean
  rememberKey?: string
}

export const ActivityRow = memo(function ActivityRow({
  icon,
  label,
  meta,
  preview,
  body,
  bodyContent,
  footnote,
  bodyMaxHeight = BODY_MAX_HEIGHT,
  live = false,
  rememberKey,
}: Props) {
  const [expanded, setExpanded] = useState(
    () => (rememberKey ? expandedRows.get(rememberKey) ?? false : false),
  )
  const bodyRef = useRef<HTMLDivElement>(null)
  const hasBody = Boolean(body) || Boolean(bodyContent)

  // A row stops streaming: fall back to whatever the reader chose (collapsed by
  // default), so finished reasoning never keeps its body in the DOM.
  useEffect(() => {
    if (live) return
    setExpanded(rememberKey ? expandedRows.get(rememberKey) ?? false : false)
  }, [live, rememberKey])

  useEffect(() => {
    if (!live) return
    const element = bodyRef.current
    if (element) element.scrollTop = element.scrollHeight
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
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          className="flex w-full min-w-0 items-center gap-1.5 text-left"
        >
          {icon}
          <span
            className="shrink-0 text-[11px] text-muted-foreground/60"
          >
            {label}
          </span>
          {meta ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">{meta}</span>
          ) : null}
          {preview && !isOpen ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/40">
              {preview}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-focus-within/activity:opacity-100 group-hover/activity:opacity-100">
            {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {icon}
          <span
            className={`shrink-0 text-[11px] ${live ? 'animate-pulse text-muted-foreground/80' : 'text-muted-foreground/60'}`}
          >
            {label}
          </span>
          {meta ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">{meta}</span>
          ) : null}
          {preview ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/40">
              {preview}
            </span>
          ) : null}
        </div>
      )}

      {isOpen && hasBody ? (
        <div
          ref={bodyRef}
          data-activity-body=""
          style={{ maxHeight: bodyMaxHeight }}
          className={`ms-[17px] mt-0.5 overflow-y-auto break-words text-[11px] leading-relaxed ${body ? 'whitespace-pre-wrap italic text-muted-foreground/60' : ''}`}
        >
          {bodyContent ?? body}
          {footnote ? (
            <div className="mt-1 not-italic text-[10px] text-muted-foreground/35">{footnote}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
