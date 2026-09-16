import { useEffect } from 'react'
import { useApiConnectivityStore } from '../../../lib/apiConnectivity'
import { useAgentSessionStore } from './agentSessionStore'

const ACTIVE_SESSION_POLL_MS = 4_000

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * Poll session list + detail while the selected session is actively running.
 * Non-overlapping: the next cycle starts only after the awaited `refreshDetail` settles, which resolves before the detached transcript task.
 */
export function useSessionDetailPolling() {
  const apiReachable = useApiConnectivityStore(s => s.apiReachable)
  const refreshDetail = useAgentSessionStore(s => s.refreshDetail)
  const refreshSessions = useAgentSessionStore(s => s.refreshSessions)
  const panelOpen = useAgentSessionStore(s => s.panelOpen)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const selectedStatus = useAgentSessionStore(s => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(sess => sess.id === id)?.status : undefined
  })

  useEffect(() => {
    if (apiReachable === 'unreachable') return
    if (!panelOpen || !selectedSessionId) return
    const isActive = selectedStatus === 'running' || selectedStatus === 'waiting_permission' || selectedStatus === 'waiting_input'
    if (!isActive) return

    let cancelled = false
    let inFlight = false
    let timer: number | null = null

    function clearTimer() {
      if (timer === null) return
      window.clearTimeout(timer)
      timer = null
    }

    function schedule() {
      clearTimer()
      if (cancelled || isDocumentHidden()) return
      timer = window.setTimeout(tick, ACTIVE_SESSION_POLL_MS)
    }

    function startRefresh() {
      inFlight = true
      void Promise.allSettled([refreshSessions(), refreshDetail()]).finally(() => {
        inFlight = false
        schedule()
      })
    }

    function tick() {
      clearTimer()
      if (cancelled || isDocumentHidden()) return
      if (inFlight) {
        schedule()
        return
      }
      startRefresh()
    }

    function handleVisibilityChange() {
      if (cancelled) return
      if (isDocumentHidden()) {
        clearTimer()
        return
      }
      tick()
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (!isDocumentHidden()) startRefresh()

    return () => {
      cancelled = true
      clearTimer()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [apiReachable, panelOpen, selectedSessionId, selectedStatus, refreshDetail, refreshSessions])
}
