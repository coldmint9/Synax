import { useEffect } from 'react'
import { ensureSessionLiveSubscription, releaseSessionLiveSubscription } from '../../../lib/api/sessionLiveClient'
import { useApiConnectivityStore } from '../../../lib/apiConnectivity'
import { useAgentSessionStore } from './agentSessionStore'

export function useSessionLiveStream(sessionId: string | null) {
  const apiReachable = useApiConnectivityStore(s => s.apiReachable)

  useEffect(() => {
    if (!sessionId) return
    if (apiReachable === 'unreachable') return

    ensureSessionLiveSubscription(sessionId, (event) => {
      useAgentSessionStore.getState().applyLiveEvent(event)
    })

    // Reconcile immediately on (re)connect so any run progress or terminal
    // status missed while the stream was down is corrected, instead of the
    // session staying stuck in a stale `running` state.
    void useAgentSessionStore.getState().refreshSessions()
    void useAgentSessionStore.getState().refreshDetail()

    return () => {
      releaseSessionLiveSubscription()
    }
  }, [sessionId, apiReachable])
}
