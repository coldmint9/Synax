import { useApiConnectivityStore } from '../apiConnectivity'

type EventHandler = (e: MessageEvent) => void
type ConnectHandler = () => void

interface Subscription {
  events?: Partial<Record<string, EventHandler>>
  onConnect?: ConnectHandler
}

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30_000

let es: EventSource | null = null
let retries = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let subscribers = new Set<Subscription>()

function connect() {
  if (useApiConnectivityStore.getState().shouldSkipRequest()) return
  if (es && es.readyState !== EventSource.CLOSED) return
  es = new EventSource('/api/agent-runtime/events/stream')

  es.addEventListener('connected', () => {
    retries = 0
    for (const sub of subscribers) sub.onConnect?.()
  })

  const eventTypes = [
    'session_changed',
    'session_step_completed',
    'session_input_queue_changed',
    'session_created',
    'session_deleted',
  ]

  for (const type of eventTypes) {
    es.addEventListener(type, (e: MessageEvent) => {
      for (const sub of subscribers) sub.events?.[type]?.(e)
    })
  }

  es.onerror = () => {
    es?.close()
    es = null
    useApiConnectivityStore.getState().markFailure()
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (useApiConnectivityStore.getState().shouldSkipRequest()) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** retries, RECONNECT_MAX_MS)
  retries++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (subscribers.size > 0) connect()
  }, delay)
}

export function subscribe(sub: Subscription): () => void {
  subscribers.add(sub)
  if (subscribers.size === 1) connect()
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) {
      es?.close()
      es = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      retries = 0
    }
  }
}

/** Resume SSE after backend connectivity is restored. */
export function resumeRuntimeEventBus(): void {
  if (subscribers.size > 0) connect()
}

export type { Subscription }
