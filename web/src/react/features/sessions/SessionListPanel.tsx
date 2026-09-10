import { useState, useEffect } from 'react'
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

export function SessionListPanel({ listView = 'sessions', projectId }: Props) {
  const { locale, t } = useLocale()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const list = useSessionList(locale, listView, projectId)
  const { refresh } = list

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showClear, setShowClear] = useState(false)

  useEffect(() => {
    if (!projectId || !list.isProjectReady) return
    void refresh()
  }, [projectId, listView, list.isProjectReady, refresh])

  const deleteSession = deleteId
    ? list.groups.flatMap(g => g.sessions).find(n => n.session.id === deleteId)?.session
    : undefined
  const deleteTitle = deleteSession ? getSessionDisplayTitle(deleteSession) : ''

  const visibleCount = list.groups.reduce((sum, g) => sum + g.sessions.length, 0)

  const handleNewSession = () => {
    list.openNewDraft()
  }

  return (
    <Surface className="session-list-panel flex h-full flex-col bg-background" variant="default">
      <SessionListHeader
        listView={listView}
        visibleCount={visibleCount}
        workflowCount={list.viewCounts.workflow}
        searchQuery={list.searchQuery}
        onSearchChange={list.setSearchQuery}
        onRefresh={() => { void list.refresh() }}
        onClearInactive={() => setShowClear(true)}
        onNewSession={handleNewSession}
        onOpenWorkflows={() => navigate(workflowSessionsPath(projectId))}
        onBackToSessions={() => navigate(sessionsPath(projectId))}
        isRefreshing={list.isRefreshing}
      />
      <div className="session-list-session-area min-h-0">
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
