import { useEffect } from 'react'
import { ensureSessionLiveSubscription, releaseSessionLiveSubscription } from '../../../lib/api/sessionLiveClient'
import { useAgentSessionStore } from './agentSessionStore'

export function useSessionLiveStream(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return
    ensureSessionLiveSubscription(sessionId, (event) => {
      useAgentSessionStore.getState().applyLiveEvent(event)
    })
    return () => {
      releaseSessionLiveSubscription()
    }
  }, [sessionId])
}
