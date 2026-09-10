import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Surface } from '@heroui/react'
import { useSessionList } from './useSessionList'
import { SessionListHeader } from './SessionListHeader'
import { SessionTimeGroups } from './SessionTimeGroups'
import { SessionDeleteDialog } from './SessionDeleteDialog'
import { SessionClearInactiveDialog } from './SessionClearInactiveDialog'
import { useLocale } from '../../../hooks/useLocale'
import type { SessionListView } from './sessionBuckets'
import { getSessionDisplayTitle } from './useSessionDisplayTitle'
import { sessionsPath, workflowSessionsPath } from './sessionRoutes'
import { clearSessionLastVisit, loadSessionLastVisit } from './sessionLastVisit'
import { SessionProfilePanel } from './SessionProfilePanel'

interface Props {
  listView?: SessionListView
  projectId: string
}

const SESSION_LIST_SPLIT_KEY = 'synax-sessions-list-split'
const SESSION_LIST_SPLIT_MIN = 0.25
const SESSION_LIST_SPLIT_MAX = 0.85

/** Ratio of the panel height given to the session list; null = built-in ratio. */
function readStoredListSplit(): number | null {
  if (typeof window === 'undefined') return null
  const value = Number(window.localStorage.getItem(SESSION_LIST_SPLIT_KEY))
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(SESSION_LIST_SPLIT_MAX, Math.max(SESSION_LIST_SPLIT_MIN, value))
}

export function SessionListPanel({ listView = 'sessions', projectId }: Props) {
  const { locale, t } = useLocale()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const list = useSessionList(locale, listView, projectId)
  const { refresh } = list

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showClear, setShowClear] = useState(false)
  const [listSplit, setListSplit] = useState<number | null>(readStoredListSplit)
  const sessionAreaRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<{ startY: number; startSplit: number; height: number } | null>(null)

  const startListSplitDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const sessionArea = sessionAreaRef.current
    const panel = sessionArea?.parentElement
    if (!sessionArea || !panel) return
    const height = panel.getBoundingClientRect().height
    if (height <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    splitDragRef.current = {
      startY: event.clientY,
      startSplit: sessionArea.getBoundingClientRect().height / height,
      height,
    }
    const handleMove = (move: PointerEvent) => {
      const drag = splitDragRef.current
      if (!drag) return
      const next = drag.startSplit + (move.clientY - drag.startY) / drag.height
      const clamped = Math.min(SESSION_LIST_SPLIT_MAX, Math.max(SESSION_LIST_SPLIT_MIN, next))
      setListSplit(clamped)
      window.localStorage.setItem(SESSION_LIST_SPLIT_KEY, String(clamped))
    }
    const handleUp = () => {
      splitDragRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }, [])

  useEffect(() => {
    if (!projectId || !list.isProjectReady) return
    void refresh()
  }, [projectId, listView, list.isProjectReady, refresh])

  const deleteSession = deleteId
    ? list.groups.flatMap(g => g.sessions).find(n => n.session.id === deleteId)?.session
    : undefined
  const deleteTitle = deleteSession ? getSessionDisplayTitle(deleteSession) : ''

  const handleNewSession = () => {
    list.openNewDraft()
  }

  return (
    <Surface className="session-list-panel flex h-full flex-col bg-background" variant="default">
      <SessionListHeader
        listView={listView}
        workflowCount={list.viewCounts.workflow}
        searchQuery={list.searchQuery}
        onSearchChange={list.setSearchQuery}
        onClearInactive={() => setShowClear(true)}
        onNewSession={handleNewSession}
        onOpenWorkflows={() => navigate(workflowSessionsPath(projectId))}
        onBackToSessions={() => navigate(sessionsPath(projectId))}
      />
      <div
        ref={sessionAreaRef}
        className="session-list-session-area min-h-0"
        style={listSplit === null ? undefined : { flexBasis: `${(listSplit * 100).toFixed(2)}%` }}
      >
        <SessionTimeGroups
          groups={list.groups}
        selectedId={list.selectedId}
        isLoadingMore={list.isLoadingMore}
        hasMore={list.hasMore}
        hideGroupHeaders
        emptyLabel={listView === 'workflow' ? t('sessionWorkflowEmpty') : t('sessionListEmpty')}
        onSelect={list.select}
        onToggleGroup={list.toggleGroup}
        onToggleExpand={list.toggleExpand}
          onLoadMore={() => { void list.loadMore() }}
          onDelete={id => setDeleteId(id)}
        />
      </div>
      <div
        className="session-list-resizer-h"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('sessionListSplitResize')}
        onPointerDown={startListSplitDrag}
      />
      <div className="session-list-profile-area min-h-0">
        <SessionProfilePanel sessionId={list.selectedId} />
      </div>

      <SessionDeleteDialog
        isOpen={deleteId !== null}
        sessionTitle={deleteTitle}
        isDeleting={deleting}
        onConfirm={async () => {
          const id = deleteId
          if (!id) return
          setDeleting(true)
          try {
            await list.deleteSession(id)
            const last = loadSessionLastVisit(projectId)
            if (last?.kind === 'session' && last.sessionId === id) {
              clearSessionLastVisit(projectId)
            }
            if (searchParams.get('session') === id) {
              navigate(listView === 'workflow' ? workflowSessionsPath(projectId) : sessionsPath(projectId))
            }
            setDeleteId(null)
            void list.refresh()
          }
          catch (err) { console.error('[DeleteSession]', err) }
          finally { setDeleting(false) }
        }}
        onClose={() => { if (!deleting) setDeleteId(null) }}
      />

      <SessionClearInactiveDialog
        isOpen={showClear}
        projectId={projectId}
        onClose={() => setShowClear(false)}
        onCleared={() => { void list.refresh() }}
      />

    </Surface>
  )
}
