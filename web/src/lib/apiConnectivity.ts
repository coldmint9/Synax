import { create } from 'zustand'
import { getApiOrigin } from './api/originConfig'
import { createOfflineError } from './appError'
import { useNotificationStore } from '../react/state/notificationStore'

export const API_CONNECTIVITY_NOTIFICATION_ID = 'api-connectivity'

const HEALTH_PATH = '/api/health'
const PROBE_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 5_000

export type ApiReachability = 'unknown' | 'reachable' | 'unreachable'

interface ApiConnectivityState {
  browserOnline: boolean
  apiReachable: ApiReachability
  failureCount: number
  lastCheckedAt: number | null

  setBrowserOnline: (online: boolean) => void
  markFailure: () => void
  markSuccess: () => void
  shouldSkipRequest: () => boolean
}

export const useApiConnectivityStore = create<ApiConnectivityState>((set, get) => ({
  browserOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  apiReachable: 'unknown',
  failureCount: 0,
  lastCheckedAt: null,

  setBrowserOnline: (online) => {
    set({ browserOnline: online })
    if (!online) get().markFailure()
  },

  markFailure: () => {
    set(s => ({
      apiReachable: 'unreachable',
      failureCount: s.failureCount + 1,
      lastCheckedAt: Date.now(),
    }))
  },

  markSuccess: () => {
    const wasUnreachable = get().apiReachable === 'unreachable'
    set({
      apiReachable: 'reachable',
      failureCount: 0,
      lastCheckedAt: Date.now(),
    })
    if (wasUnreachable) {
      useNotificationStore.getState().dismiss(API_CONNECTIVITY_NOTIFICATION_ID)
      void import('./api/runtimeEventBus').then(m => m.resumeRuntimeEventBus())
    }
  },

  shouldSkipRequest: () => {
    const { browserOnline, apiReachable } = get()
    return !browserOnline || apiReachable === 'unreachable'
  },
}))

export { createOfflineError, isOfflineError } from './appError'

export function notifyConnectivityFailure(message: string, bump = true): void {
  useNotificationStore.getState().pushAggregated({
    id: API_CONNECTIVITY_NOTIFICATION_ID,
    type: 'warning',
    message,
    duration: 0,
    bump,
  })
}

export async function probeApiHealth(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(`${getApiOrigin()}${HEALTH_PATH}`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    })
    if (resp.ok) {
      useApiConnectivityStore.getState().markSuccess()
      return true
    }
    useApiConnectivityStore.getState().markFailure()
    return false
  } catch {
    useApiConnectivityStore.getState().markFailure()
    return false
  } finally {
    clearTimeout(timer)
  }
}

let monitorStarted = false
let probeTimer: ReturnType<typeof setInterval> | null = null

export function startApiConnectivityMonitor(): () => void {
  if (monitorStarted || typeof window === 'undefined') return () => {}
  monitorStarted = true

  const store = useApiConnectivityStore.getState()

  const onOnline = () => {
    store.setBrowserOnline(true)
    void probeApiHealth()
  }
  const onOffline = () => {
    store.setBrowserOnline(false)
    notifyConnectivityFailure('网络已断开，请检查连接')
  }

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  void probeApiHealth()

  probeTimer = setInterval(() => {
    if (useApiConnectivityStore.getState().apiReachable === 'unreachable') {
      void probeApiHealth()
    }
  }, PROBE_INTERVAL_MS)

  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    if (probeTimer) clearInterval(probeTimer)
    probeTimer = null
    monitorStarted = false
  }
}
