import { useEffect, useState } from 'react'
import { configApi } from '../../../../lib/api/config'
import type { AcpDiscoveryItem } from '../../../../lib/contracts/config'

let cached: AcpDiscoveryItem[] | null = null
let inflight: Promise<AcpDiscoveryItem[]> | null = null
let idlePrefetchScheduled = false

export async function loadAcpDiscovery(): Promise<AcpDiscoveryItem[]> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = configApi.discoverAcp()
    .then((result) => {
      cached = result.supported
      return cached
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Fire-and-forget after browser idle — does not block session open / composer mount. */
export function prefetchAcpDiscoveryIdle(): void {
  if (typeof window === 'undefined' || cached || inflight || idlePrefetchScheduled) return
  idlePrefetchScheduled = true
  const run = () => {
    void loadAcpDiscovery().catch(() => {})
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => run(), { timeout: 8_000 })
  } else {
    window.setTimeout(run, 2_000)
  }
}

/** Test helper — clear module memoization. */
export function resetAcpDiscoveryCacheForTests(): void {
  cached = null
  inflight = null
  idlePrefetchScheduled = false
}

export type UseAcpDiscoveryOptions = {
  /** When false, return cache only and do not start a network request. Default true. */
  enabled?: boolean
}

/**
 * Shared ACP discovery.
 * Pass `enabled: false` until needed (e.g. model picker open) so session select stays off the critical path.
 */
export function useAcpDiscovery(options: UseAcpDiscoveryOptions = {}): AcpDiscoveryItem[] {
  const enabled = options.enabled ?? true
  const [acpDiscovery, setAcpDiscovery] = useState<AcpDiscoveryItem[]>(() => cached ?? [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void loadAcpDiscovery()
      .then((items) => {
        if (!cancelled) setAcpDiscovery(items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled])

  // If cache filled by idle prefetch while this hook was disabled, pick it up when enabling.
  useEffect(() => {
    if (enabled && cached) setAcpDiscovery(cached)
  }, [enabled])

  return acpDiscovery
}
