import { memo, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
  const bodyId = useId()
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

  const heading = (
    <>
      {icon && <span className="bui-activity-symbol">{icon}</span>}
      <span className="bui-activity-label">{label}</span>
      {meta && <span className="bui-activity-meta" title={meta}>{meta}</span>}
      {preview && !isOpen && <span className="bui-activity-preview">{preview}</span>}
      {interactive && (isOpen
        ? <ChevronDown size={12} className="bui-chevron" aria-hidden="true" />
        : <ChevronRight size={12} className="bui-chevron" aria-hidden="true" />)}
    </>
  )

  return (
    <div className="bui-activity" data-live={live || undefined}>
      {interactive ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-controls={isOpen ? bodyId : undefined}
          className="bui-activity-trigger"
        >
          {heading}
        </button>
      ) : <div className="bui-activity-trigger">{heading}</div>}
      {isOpen && hasBody ? (
        <div
          id={bodyId}
          ref={bodyRef}
          data-activity-body=""
          data-plain={Boolean(body) || undefined}
          style={{ maxHeight: bodyMaxHeight }}
          className="bui-activity-body"
        >
          {bodyContent ?? body}
          {footnote ? <div className="bui-activity-footnote">{footnote}</div> : null}
        </div>
      ) : null}
    </div>
  )
})
