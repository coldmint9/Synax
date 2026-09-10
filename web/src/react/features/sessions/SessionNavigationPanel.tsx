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
 * further out settles back to the resting 10px hairline.
 */
const RIPPLE_WIDTHS = [42, 40, 28, 20]
const RESTING_WIDTH = 10

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

/** First readable line of a turn: its prose if there is any, else its thinking. */
function firstTurnText(turn: InterleavedTurn): string {
  const text = turn.blocks.find(block => block.type === 'text' && block.content.trim())
  if (text && text.type === 'text') return text.content
  const thinking = turn.blocks.find(block => block.type === 'thinking' && block.content.trim())
  if (thinking && thinking.type === 'thinking') return thinking.content
  return ''
}

/** Closing prose of a turn — what the reader gets out of it. */
function lastTurnText(turn: InterleavedTurn): string {
  for (let index = turn.blocks.length - 1; index >= 0; index -= 1) {
    const block = turn.blocks[index]
    if (block.type === 'text' && block.content.trim()) return block.content
  }
  return firstTurnText(turn)
}

/** One rail tick stands for a whole conversation turn. */
export interface RailTurn {
  /** Anchor entry: the transcript node the tick scrolls to (usually the prompt). */
  id: string
  members: ConversationTimelineEntry[]
}

/**
 * Fold the transcript timeline into conversation turns: a user message opens a
 * turn and every agent step after it — folded work logs included — belongs to
 * that turn. Think rounds therefore never get a tick of their own, so the rail
 * stays a ruler of turns instead of a ruler of steps.
 */
export function groupTimelineIntoTurns(entries: ConversationTimelineEntry[]): RailTurn[] {
  const turns: RailTurn[] = []
  for (const entry of entries) {
    if (entry.kind === 'user' || turns.length === 0) {
      turns.push({ id: entry.id, members: [entry] })
      continue
    }
    turns[turns.length - 1].members.push(entry)
  }
  return turns
}

/**
 * The label is derived from the same text as the body, so the shared prefix is
 * stripped: the card reads as a heading plus the remainder instead of printing
 * the same sentence twice.
 */
function stripLabelStem(title: string, raw: string): string {
  const stem = title.replace(/…$/, '')
  let trimmed = raw.startsWith(stem) ? raw.slice(stem.length).trim() : raw.trim()
  // A truncated label cuts mid-sentence, so the remainder starts on the
  // punctuation that followed it — drop that dangling separator.
  if (title.endsWith('…')) trimmed = trimmed.replace(/^[，,。.；;：:、\s]+/, '')
  return trimmed
}

/** Hover card for a turn: the prompt on top, the last answer of the turn below. */
export function turnPreview(turn: RailTurn, emptyLabel = '(无内容)'): { title: string; body: string } {
  const head = turn.members[0]
  const title = head.label || emptyLabel
  // Injected scaffolding is summarised everywhere — never echo the payload.
  if (head.kind === 'user' && head.injected) return { title, body: '' }

  const answers = turn.members
    .filter(member => member.kind !== 'user')
    .map((member) => {
      if (member.kind === 'agent') return lastTurnText(member.turn)
      if (member.kind === 'work_log') return member.turns.map(lastTurnText).find(text => text.trim()) ?? ''
      return ''
    })
    .filter(text => text.trim())

  const raw = answers[answers.length - 1] ?? (head.kind === 'user' ? head.content : '')
  return { title, body: stripLabelStem(title, raw) }
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
  const turns = useMemo(() => groupTimelineIntoTurns(entries), [entries])

  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [railHovered, setRailHovered] = useState(false)

  useEffect(() => {
    setActiveId(null)
    setHoverIndex(null)
  }, [selectedSessionId])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || turns.length === 0) {
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
      for (const turn of turns) {
        const element = root.querySelector(`#${sessionEntryDomId(turn.id)}`)
        if (!(element instanceof HTMLElement)) continue
        next.push({ id: turn.id, top: element.getBoundingClientRect().top - rootTop + root.scrollTop })
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
  }, [turns, scrollRootRef, selectedSessionId])

  const jump = useCallback((entryId: string) => {
    scrollToEntry(scrollRootRef.current, entryId)
  }, [scrollRootRef])

  if (turns.length === 0) return null

  const hoveredTurn = hoverIndex === null ? null : turns[hoverIndex]
  const preview = hoveredTurn ? turnPreview(hoveredTurn, t('sessionNavEmpty')) : null

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
          {turns.map((turn, index) => {
            const distance = hoverIndex === null ? null : Math.abs(index - hoverIndex)
            const width = distance === null
              ? RESTING_WIDTH
              : (RIPPLE_WIDTHS[distance] ?? RESTING_WIDTH)

            return (
              <li key={turn.id} className="session-nav-float-item">
                <button
                  type="button"
                  onClick={() => jump(turn.id)}
                  onMouseEnter={() => setHoverIndex(index)}
                  onFocus={() => setHoverIndex(index)}
                  aria-label={t('sessionNavJumpTo', { index: index + 1, label: turn.members[0].label || t('sessionNavEmpty') })}
                  aria-current={activeId === turn.id ? 'true' : undefined}
                  className="session-nav-float-mark"
                  data-active={activeId === turn.id ? 'true' : undefined}
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
