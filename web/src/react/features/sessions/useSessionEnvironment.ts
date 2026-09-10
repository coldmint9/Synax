import { useCallback, useEffect, useRef, useState } from 'react'
import { agentRuntimeApi, type SessionEnvironment } from '../../../lib/api/agentRuntime'

const REFRESH_MS = 8000

/**
 * Polls the session workspace snapshot (branch, diffs, input files, subagents).
 *
 * Shared by the workspace dashboard and the tab bar's "open a tab" menu so the
 * panel keeps a single poller instead of one per consumer.
 */
export function useSessionEnvironment(sessionId: string | null) {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null)
  const [loading, setLoading] = useState(false)
  const activeId = useRef(sessionId)

  const reload = useCallback(async () => {
    const id = sessionId
    if (!id) return
    setLoading(true)
    try {
      const next = await agentRuntimeApi.getSessionEnvironment(id)
      // Ignore a response that arrived after the session switched.
      if (activeId.current === id) setEnvironment(next)
    } catch {
      if (activeId.current === id) setEnvironment(null)
    } finally {
      if (activeId.current === id) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    activeId.current = sessionId
    setEnvironment(null)
    if (!sessionId) return
    void reload()
    const timer = window.setInterval(() => void reload(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [sessionId, reload])

  return { environment, loading, reload }
}
