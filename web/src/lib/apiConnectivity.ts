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
  recoveryVersion: number

  setBrowserOnline: (online: boolean) => void
  markFailure: () => void
  markSuccess: (resumed?: boolean) => void
  shouldSkipRequest: () => boolean
}

export const useApiConnectivityStore = create<ApiConnectivityState>((set, get) => ({
  browserOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  apiReachable: 'unknown',
  failureCount: 0,
  lastCheckedAt: null,
  recoveryVersion: 0,

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

  markSuccess: (resumed = false) => {
    const wasUnreachable = get().apiReachable === 'unreachable'
    set(s => ({
      apiReachable: 'reachable',
      failureCount: 0,
      lastCheckedAt: Date.now(),
      recoveryVersion: s.recoveryVersion + (wasUnreachable || resumed ? 1 : 0),
    }))
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

let pendingProbe: Promise<boolean> | null = null
let resumeRequested = false

export function probeApiHealth(resumed = false): Promise<boolean> {
  resumeRequested ||= resumed
  if (!pendingProbe) {
    pendingProbe = runHealthProbe().finally(() => {
      pendingProbe = null
      resumeRequested = false
    })
  }
  return pendingProbe
}

async function runHealthProbe(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(`${getApiOrigin()}${HEALTH_PATH}`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    })
    if (resp.ok) {
      useApiConnectivityStore.getState().markSuccess(resumeRequested)
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
  let lastTickAt = Date.now()
  let lastResumeAt = -Infinity

  const onResume = () => {
    store.setBrowserOnline(navigator.onLine)
    if (!navigator.onLine || Date.now() - lastResumeAt < 1000) return
    lastResumeAt = Date.now()
    void probeApiHealth(true)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onResume()
  }
  const onOffline = () => {
    store.setBrowserOnline(false)
    notifyConnectivityFailure('网络已断开，请检查连接')
  }

  window.addEventListener('online', onResume)
  window.addEventListener('offline', onOffline)
  window.addEventListener('focus', onResume)
  window.addEventListener('pageshow', onResume)
  document.addEventListener('visibilitychange', onVisibility)

  void probeApiHealth()

  probeTimer = setInterval(() => {
    const now = Date.now()
    // Sleep may suspend timers without producing online or visibility events.
    const wasSuspended = now - lastTickAt > PROBE_INTERVAL_MS * 2
    lastTickAt = now
    if (wasSuspended) {
      onResume()
    } else if (useApiConnectivityStore.getState().apiReachable === 'unreachable') {
      store.setBrowserOnline(navigator.onLine)
      void probeApiHealth()
    }
  }, PROBE_INTERVAL_MS)

  return () => {
    window.removeEventListener('online', onResume)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('focus', onResume)
    window.removeEventListener('pageshow', onResume)
    document.removeEventListener('visibilitychange', onVisibility)
    if (probeTimer) clearInterval(probeTimer)
    probeTimer = null
    monitorStarted = false
  }
}
