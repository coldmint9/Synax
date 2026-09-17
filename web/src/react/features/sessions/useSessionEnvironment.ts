import { useCallback, useEffect, useRef, useState } from 'react'
import { agentRuntimeApi, type SessionEnvironment } from '../../../lib/api/agentRuntime'

// Write tool results invalidate the server cache immediately (see
// RuntimeStreamWriter); this slow poll is only a drift safety net.
const REFRESH_MS = 30_000
const cache = new Map<string, SessionEnvironment>()
const pending = new Map<string, Promise<SessionEnvironment>>()

/** Shared in-flight requests and a bounded stale-while-revalidate workspace cache. */
export function useSessionEnvironment(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<{ id: string; value: SessionEnvironment } | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    if (!sessionId) return
    const id = sessionId
    const version = generation.current
    setLoadingId(id)
    try {
      let request = pending.get(id)
      if (!request) {
        request = agentRuntimeApi
          .getSessionEnvironment(id)
          .then((next) => {
            const previous = cache.get(id)
            const value = previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
            cache.delete(id)
            cache.set(id, value)
            if (cache.size > 16) cache.delete(cache.keys().next().value!)
            return value
          })
          .finally(() => pending.delete(id))
        pending.set(id, request)
      }
      const value = await request
      if (generation.current === version)
        setSnapshot((previous) =>
          previous?.id === id && previous.value === value ? previous : { id, value },
        )
    } catch {
      // A transient poll failure must not clear the last usable workspace.
    } finally {
      if (generation.current === version) setLoadingId(null)
    }
  }, [sessionId])

  useEffect(() => {
    ++generation.current
    if (!sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    const tick = async () => {
      if (cancelled || document.hidden || inFlight) return
      clearTimeout(timer)
      inFlight = true
      await reload()
      inFlight = false
      if (!cancelled && !document.hidden) timer = setTimeout(tick, REFRESH_MS)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void tick()
    return () => {
      cancelled = true
      ++generation.current
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, reload])

  const environment = sessionId
    ? snapshot?.id === sessionId
      ? snapshot.value
      : (cache.get(sessionId) ?? null)
    : null
  return { sessionId, environment, loading: sessionId !== null && loadingId === sessionId, reload }
}
