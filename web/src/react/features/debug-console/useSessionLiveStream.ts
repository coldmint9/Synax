import { useEffect } from 'react'
import { sessionLiveStream } from '../../../lib/api/sessionLive'
import { useDebugConsole } from './debugConsoleStore'

export function useSessionLiveStream(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return
    const unsubscribe = sessionLiveStream(
      sessionId,
      (event) => {
        useDebugConsole.getState().applyLiveEvent(event)
      },
    )
    return unsubscribe
  }, [sessionId])
}
