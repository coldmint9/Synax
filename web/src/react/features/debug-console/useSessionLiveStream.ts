import { useEffect } from 'react'
import { ensureSessionLiveSubscription, releaseSessionLiveSubscription } from '../../../lib/api/sessionLiveClient'
import { useDebugConsole } from './debugConsoleStore'

export function useSessionLiveStream(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return
    ensureSessionLiveSubscription(sessionId, (event) => {
      useDebugConsole.getState().applyLiveEvent(event)
    })
    return () => {
      releaseSessionLiveSubscription()
    }
  }, [sessionId])
}
