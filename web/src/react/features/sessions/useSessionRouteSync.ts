import { useEffect } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import { isNewGoalSessionPath } from './sessionRoutes'
import type { SessionListView } from './sessionBuckets'

/** Keep agent session detail in sync with sessions URL. */
export function useSessionRouteSync(listView: SessionListView) {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const openPanel = useAgentSessionStore(s => s.openPanel)
  const resetForDraft = useAgentSessionStore(s => s.resetSessionDetailForDraft)
  const closePanel = useAgentSessionStore(s => s.closePanel)

  useEffect(() => {
    if (listView !== 'goal') {
      closePanel()
      return
    }

    if (isNewGoalSessionPath(location.pathname)) {
      resetForDraft()
      return
    }

    const sessionId = searchParams.get('session')
    if (sessionId) {
      openPanel(sessionId)
      return
    }

    if (location.pathname.endsWith('/sessions')) {
      closePanel()
    }
  }, [listView, location.pathname, searchParams, openPanel, resetForDraft, closePanel])
}
