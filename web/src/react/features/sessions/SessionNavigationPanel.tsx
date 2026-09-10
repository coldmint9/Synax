import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLocale } from '../../../hooks/useLocale'
import {
  buildConversationTimeline,
  sessionEntryDomId,
  type ConversationTimelineEntry,
} from './buildConversationTimeline'
import type { InterleavedTurn } from './buildInterleavedTurns'
import { useAgentSessionStore } from './agentSessionStore'

interface Props {
  scrollRootRef: React.RefObject<HTMLElement | null>
}

/**
 * Tick width per distance from the hovered turn. Numbers come from the design
 * reference: the hovered mark is 42px, then 40 / 28 / 20, and everything
 * further out settles back to the resting 12px.
 */
const RIPPLE_WIDTHS = [42, 40, 28, 20]
const RESTING_WIDTH = 12

/** Where in the scrollport the "you are here" probe line sits. */
const PROBE_RATIO = 0.35

/**
 * Picks the turn that owns the probe line.
 *
 * `offsets` are each entry's top measured against the scroll content. The first
 * and last turns sit at the ends of the document, so a mid-viewport probe can
 * never reach them — they are pinned to the scroll extremes instead. Without
 * that, the top and bottom ticks could never become active.
 */
export function resolveActiveEntryIndex(
  offsets: number[],
  scrollTop: number,
  clientHeight: number,
  maxScroll: number,
): number {
  if (offsets.length === 0) return -1
  if (scrollTop <= 2) return 0
  if (maxScroll - scrollTop <= 2) return offsets.length - 1

  const probe = scrollTop + clientHeight * PROBE_RATIO
  let lo = 0
  let hi = offsets.length - 1
  let chosen = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= probe) {
      chosen = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return chosen
}

function scrollToEntry(scrollRoot: HTMLElement | null, entryId: string) {
  // The anchor element is always in the DOM, but its body may still be a height
  // reservation that only mounts once it approaches the viewport. Re-centre
  // after that swap, otherwise jumping to an older message lands short.
  const target = scrollRoot?.querySelector(`#${sessionEntryDomId(entryId)}`)
  if (!(target instanceof HTMLElement)) return

  const reservedHeight = target.getBoundingClientRect().height
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })

  window.setTimeout(() => {
    if (Math.abs(target.getBoundingClientRect().height - reservedHeight) <= 1) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, 140)
}

/**
 * Plain-text gist of a turn, used by the hover preview card.
 *
 * For both kinds the label is derived from the same text as the body, so the
 * shared prefix is stripped: the card reads as a heading plus the remainder
 * instead of printing the same sentence twice.
 */
/** First readable line of a turn: its prose if there is any, else its thinking. */
function firstTurnText(turn: InterleavedTurn): string {
  const text = turn.blocks.find(block => block.type === 'text' && block.content.trim())
  if (text && text.type === 'text') return text.content
  const thinking = turn.blocks.find(block => block.type === 'thinking' && block.content.trim())
  if (thinking && thinking.type === 'thinking') return thinking.content
  return ''
}

function entryPreview(entry: ConversationTimelineEntry): { title: string; body: string } {
  // Injected scaffolding is summarised everywhere — never echo the payload.
  if (entry.kind === 'user' && entry.injected) {
    return { title: entry.label, body: '' }
  }

  const title = entry.label
  const turns = entry.kind === 'agent'
    ? [entry.turn]
    : entry.kind === 'work_log'
      ? entry.turns
      : []
  const raw = entry.kind === 'user' ? entry.content : turns.map(firstTurnText).find(text => text) ?? ''

  const stem = title.replace(/…$/, '')
  let trimmed = raw.startsWith(stem) ? raw.slice(stem.length).trim() : raw.trim()
  // A truncated label cuts mid-sentence, so the remainder starts on the
  // punctuation that followed it — drop that dangling separator.
  if (title.endsWith('…')) trimmed = trimmed.replace(/^[，,。.；;：:、\s]+/, '')
  return { title: title || '(无内容)', body: trimmed }
}

export const SessionNavigationPanel = memo(function SessionNavigationPanel({ scrollRootRef }: Props) {
  const { t } = useLocale()
  const { selectedSessionId, session, runs, steps, messages, toolCalls, childSessions } =
    useAgentSessionStore(useShallow(state => ({
      selectedSessionId: state.selectedSessionId,
      session: state.selectedSessionId
        ? state.sessions.find(item => item.id === state.selectedSessionId)
        : undefined,
      runs: state.runs,
      steps: state.steps,
      messages: state.messages,
      toolCalls: state.toolCalls,
      childSessions: state.selectedSessionId ? state.childSessions[state.selectedSessionId] : undefined,
    })))

  const entries = useMemo(
    () => buildConversationTimeline(runs, steps, messages, toolCalls, childSessions, { session }),
    [runs, steps, messages, toolCalls, childSessions, session],
  )

  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [railHovered, setRailHovered] = useState(false)

  useEffect(() => {
    setActiveId(null)
    setHoverIndex(null)
  }, [selectedSessionId])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || entries.length === 0) {
      setActiveId(null)
      return
    }

    // Anchor offsets are memoised: scrolling only binary-searches them, and a
    // resize re-measures (lazy transcript entries change height as they mount).
    let offsets: Array<{ id: string; top: number }> = []
    let frame = 0

    const measureOffsets = () => {
      const rootTop = root.getBoundingClientRect().top
      const next: Array<{ id: string; top: number }> = []
      for (const entry of entries) {
        const element = root.querySelector(`#${sessionEntryDomId(entry.id)}`)
        if (!(element instanceof HTMLElement)) continue
        next.push({ id: entry.id, top: element.getBoundingClientRect().top - rootTop + root.scrollTop })
      }
      offsets = next
    }

    const update = () => {
      frame = 0
      if (offsets.length === 0) return

      const chosen = resolveActiveEntryIndex(
        offsets.map(offset => offset.top),
        root.scrollTop,
        root.clientHeight,
        root.scrollHeight - root.clientHeight,
      )
      if (chosen >= 0) setActiveId(offsets[chosen].id)
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const onLayoutChange = () => {
      measureOffsets()
      update()
    }

    measureOffsets()
    update()
    root.addEventListener('scroll', onScroll, { passive: true })

    const content = root.firstElementChild
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onLayoutChange)
    if (observer && content) observer.observe(content)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [entries, scrollRootRef, selectedSessionId])

  const jump = useCallback((entryId: string) => {
    scrollToEntry(scrollRootRef.current, entryId)
  }, [scrollRootRef])

  if (entries.length === 0) return null

  const hoveredEntry = hoverIndex === null ? null : entries[hoverIndex]
  const preview = hoveredEntry ? entryPreview(hoveredEntry) : null

  return (
    <nav
      className="session-nav-float"
      aria-label={t('sessionNavTitle')}
      data-hovered={railHovered ? 'true' : undefined}
      onMouseEnter={() => setRailHovered(true)}
      onMouseLeave={() => {
        setRailHovered(false)
        setHoverIndex(null)
      }}
    >
      <div className="session-nav-float-rail" onMouseLeave={() => setHoverIndex(null)}>
        {preview ? (
          <div className="session-nav-preview" role="tooltip">
            <div className="session-nav-preview-title">{preview.title}</div>
            {preview.body ? <div className="session-nav-preview-body">{preview.body}</div> : null}
          </div>
        ) : null}

        <ol className="session-nav-float-list">
          {entries.map((entry, index) => {
            const distance = hoverIndex === null ? null : Math.abs(index - hoverIndex)
            const width = distance === null
              ? RESTING_WIDTH
              : (RIPPLE_WIDTHS[distance] ?? RESTING_WIDTH)

            return (
              <li key={entry.id} className="session-nav-float-item">
                <button
                  type="button"
                  onClick={() => jump(entry.id)}
                  onMouseEnter={() => setHoverIndex(index)}
                  onFocus={() => setHoverIndex(index)}
                  aria-label={t('sessionNavJumpTo', { index: index + 1, label: entry.label })}
                  aria-current={activeId === entry.id ? 'true' : undefined}
                  className="session-nav-float-mark"
                  data-active={activeId === entry.id ? 'true' : undefined}
                  data-hovered={hoverIndex === index ? 'true' : undefined}
                >
                  <span className="session-nav-float-tick" style={{ width }} />
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </nav>
  )
})
