import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { sessionEntryDomId, type ConversationTimelineEntry } from './buildConversationTimeline'

/**
 * Heights measured during an earlier render, keyed by timeline entry.
 *
 * Module level on purpose: the value survives unmounts and session switches so
 * scrolling back into a transcript restores the real geometry instead of
 * re-estimating it from scratch.
 */
const measuredEntryHeights = new Map<string, number>()

/**
 * How far outside the scrollport an entry is still mounted. Roughly one screen
 * of slack, so flick-scrolling does not run into empty reservations.
 */
const PRELOAD_MARGIN = '1200px 0px'
const viewportObservers = new Map<Element | null, {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}>()

const FALLBACK_ENTRY_HEIGHT = 180

/**
 * Cheap height estimate derived from the entry shape. It is only used until a
 * real measurement exists, but being in the right order of magnitude is what
 * keeps the scrollbar from lurching while the transcript settles.
 */
export function estimateEntryHeight(entry: ConversationTimelineEntry): number {
  if (entry.kind === 'user') {
    return Math.min(600, 72 + Math.ceil(entry.content.length / 80) * 20)
  }

  if (entry.kind === 'work_log') {
    // Folded runs render as a single collapsed activity row.
    return 28
  }

  let height = 28 // turn chrome + divider
  for (const block of entry.turn.blocks) {
    switch (block.type) {
      case 'thinking':
        height += 20 // one collapsed activity line
        break
      case 'text':
        height += Math.min(720, 40 + Math.ceil(block.content.length / 80) * 20)
        break
      case 'tool_call':
        height += 46
        break
      case 'tool_call_group':
        height += 46 + Math.max(0, block.calls.length - 1) * 34
        break
      case 'sub_session':
        height += 76
        break
      case 'context_compacted':
        height += 40
        break
    }
  }
  return height
}

interface Props {
  entryId: string
  cacheKey: string
  estimate: number
  scrollRootRef?: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * Renders one transcript entry, but only once it has come near the viewport.
 *
 * The wrapper itself is always in the DOM so anchor ids and the navigation
 * panel stay correct; the (potentially expensive) entry body is what gets
 * deferred. Mounted entries lay out for real — deliberately no
 * `content-visibility`, because reserving an estimated height for content that
 * is already mounted makes the scrollbar grow while you scroll. Only entries
 * that have never been near the viewport carry a reservation.
 *
 * Bodies are never unmounted again once shown: that rendered subtree, plus the
 * `measuredEntryHeights` map, is the cache.
 */
export function TimelineLazyEntry({ entryId, cacheKey, estimate, scrollRootRef, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Without IntersectionObserver (unit tests, older runtimes) render eagerly
  // rather than leaving the transcript permanently blank.
  const [mounted, setMounted] = useState(() => typeof IntersectionObserver === 'undefined')
  const reservedHeight = measuredEntryHeights.get(cacheKey) ?? estimate ?? FALLBACK_ENTRY_HEIGHT

  useEffect(() => {
    if (mounted) return
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setMounted(true)
      return
    }

    const root = scrollRootRef?.current ?? null
    let shared = viewportObservers.get(root)
    if (!shared) {
      const callbacks = new Map<Element, () => void>()
      const observer = new IntersectionObserver(records => {
        for (const record of records) {
          if (record.isIntersecting) callbacks.get(record.target)?.()
        }
      }, { root, rootMargin: PRELOAD_MARGIN })
      shared = { observer, callbacks }
      viewportObservers.set(root, shared)
    }
    shared.callbacks.set(element, () => setMounted(true))
    shared.observer.observe(element)
    return () => {
      shared.callbacks.delete(element)
      shared.observer.unobserve(element)
      if (shared.callbacks.size === 0) {
        shared.observer.disconnect()
        viewportObservers.delete(root)
      }
    }
  }, [mounted, scrollRootRef])

  useEffect(() => {
    if (!mounted || typeof ResizeObserver === 'undefined') return
    const element = ref.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      const height = element.getBoundingClientRect().height
      if (height > 0) {
        measuredEntryHeights.delete(cacheKey)
        measuredEntryHeights.set(cacheKey, height)
        if (measuredEntryHeights.size > 2000)
          measuredEntryHeights.delete(measuredEntryHeights.keys().next().value!)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [mounted, cacheKey])

  return (
    <div
      ref={ref}
      id={sessionEntryDomId(entryId)}
      data-session-entry={entryId}
      className="scroll-mt-4"
      style={mounted ? undefined : { minHeight: Math.round(reservedHeight) }}
    >
      {mounted ? children : null}
    </div>
  )
}
