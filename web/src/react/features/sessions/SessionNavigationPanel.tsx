import { memo, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLocale } from '../../../hooks/useLocale'
import { useAgentSessionStore } from './agentSessionStore'
import {
  buildUserMessageEntries,
  sessionEntryDomId,
  type UserMessageTimelineEntry,
} from './buildConversationTimeline'

interface Props {
  scrollRootRef: React.RefObject<HTMLElement | null>
}

function scrollToEntry(scrollRoot: HTMLElement | null, entryId: string) {
  const target = scrollRoot?.querySelector(`#${sessionEntryDomId(entryId)}`)
  if (target instanceof HTMLElement) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

export const SessionNavigationPanel = memo(function SessionNavigationPanel({ scrollRootRef }: Props) {
  const { t } = useLocale()
  const { selectedSessionId, session, messages } = useAgentSessionStore(useShallow(s => {
    const id = s.selectedSessionId
    return {
      selectedSessionId: id,
      session: id ? s.sessions.find(item => item.id === id) : undefined,
      messages: s.messages,
    }
  }))

  const entries = useMemo(
    () => buildUserMessageEntries(messages, session),
    [messages, session],
  )

  const [activeId, setActiveId] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    setActiveId(null)
  }, [selectedSessionId])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || entries.length === 0) {
      setActiveId(null)
      return
    }

    const targets = entries
      .map(entry => root.querySelector(`#${sessionEntryDomId(entry.id)}`))
      .filter((node): node is HTMLElement => node instanceof HTMLElement)

    if (targets.length === 0) return

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter(record => record.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        if (visible[0]?.target.id) {
          setActiveId(visible[0].target.id.replace(/^session-entry-/, ''))
        }
      },
      { root, rootMargin: '-24% 0px -50% 0px', threshold: [0, 0.35, 0.65, 1] },
    )

    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [entries, scrollRootRef, selectedSessionId])

  if (entries.length === 0) return null

  return (
    <nav
      className="session-nav-float"
      aria-label={t('sessionNavTitle')}
      data-hovered={hovered ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="session-nav-float-rail">
        <span className="session-nav-float-axis" aria-hidden="true" />
        <ol className="session-nav-float-list">
          {entries.map((entry, index) => (
            <TimelineMark
              key={entry.id}
              entry={entry}
              index={index}
              active={activeId === entry.id}
              onClick={() => scrollToEntry(scrollRootRef.current, entry.id)}
            />
          ))}
        </ol>
      </div>
    </nav>
  )
})

function TimelineMark({
  entry,
  index,
  active,
  onClick,
}: {
  entry: UserMessageTimelineEntry
  index: number
  active: boolean
  onClick: () => void
}) {
  const { t } = useLocale()

  return (
    <li className="session-nav-float-item">
      <button
        type="button"
        onClick={onClick}
        aria-label={t('sessionNavJumpTo', { index: index + 1, label: entry.label })}
        aria-current={active ? 'true' : undefined}
        className="session-nav-float-mark"
        data-active={active ? 'true' : undefined}
      >
        <span className="session-nav-float-dot" />
      </button>

      <div className="session-nav-float-card" aria-hidden="true">
        <span className="session-nav-float-card-index">{index + 1}</span>
        <span className="session-nav-float-card-label">{entry.label}</span>
      </div>
    </li>
  )
}
