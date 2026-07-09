import { useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import {
  sessionPath,
  isBareSessionsPath,
  isNewSessionPath,
  newSessionPath,
} from './sessionRoutes'
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
  saveSessionLastVisit,
} from './sessionLastVisit'
import type { SessionListView } from './sessionBuckets'

/** Keep agent session detail in sync with sessions URL. */
export function useSessionRouteSync(listView: SessionListView, projectId: string) {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const openPanel = useAgentSessionStore(s => s.openPanel)
  const resetForDraft = useAgentSessionStore(s => s.resetSessionDetailForDraft)
  const closePanel = useAgentSessionStore(s => s.closePanel)
  const storeProjectId = useAgentSessionStore(s => s.projectId)
  const sessions = useAgentSessionStore(s => s.sessions)
  const sessionIdFromUrl = searchParams.get('session')
  const isProjectReady = Boolean(projectId) && storeProjectId === projectId

  useEffect(() => {
    if (!isProjectReady || listView !== 'sessions' || !projectId) return
    if (sessionIdFromUrl || isNewSessionPath(location.pathname)) return
    if (!isBareSessionsPath(location.pathname, projectId)) return

    const last = loadSessionLastVisit(projectId)
    if (!last) return

    if (last.kind === 'new') {
      navigate(newSessionPath(projectId), { replace: true })
      return
    }

    if (sessions.length > 0) {
      const exists = sessions.some(s => s.id === last.sessionId)
      if (!exists) {
        clearSessionLastVisit(projectId)
        return
      }
    }

    navigate(sessionPath(projectId, last.sessionId), { replace: true })
  }, [
    isProjectReady,
    listView,
    location.pathname,
    projectId,
    sessionIdFromUrl,
    sessions,
    navigate,
  ])

  useEffect(() => {
    if (listView === 'workflow') {
      if (sessionIdFromUrl) {
        openPanel(sessionIdFromUrl)
        return
      }
      closePanel()
      return
    }

    if (listView !== 'sessions') {
      closePanel()
      return
    }

    if (isNewSessionPath(location.pathname)) {
      if (projectId) saveSessionLastVisit(projectId, { kind: 'new' })
      resetForDraft()
      return
    }

    if (sessionIdFromUrl) {
      if (projectId) {
        saveSessionLastVisit(projectId, { kind: 'session', sessionId: sessionIdFromUrl })
      }
      openPanel(sessionIdFromUrl)
      return
    }

    if (isBareSessionsPath(location.pathname, projectId || undefined)) {
      closePanel()
    }
  }, [
    listView,
    location.pathname,
    sessionIdFromUrl,
    projectId,
    openPanel,
    resetForDraft,
    closePanel,
  ])
}
