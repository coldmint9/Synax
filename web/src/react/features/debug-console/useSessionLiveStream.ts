import { useEffect } from 'react'
import { ensureSessionLiveSubscription } from '../../../lib/api/sessionLiveClient'
import { useDebugConsole } from './debugConsoleStore'

export function useSessionLiveStream(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return
    ensureSessionLiveSubscription(sessionId, (event) => {
      useDebugConsole.getState().applyLiveEvent(event)
    })
  }, [sessionId])
}
