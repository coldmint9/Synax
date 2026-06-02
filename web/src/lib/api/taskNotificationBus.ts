import { SseEventType, TaskNotificationEventType } from './eventTypes'

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
let currentProjectId: string | null = null

function connect(projectId: string) {
  if (es && es.readyState !== EventSource.CLOSED) return
  currentProjectId = projectId
  es = new EventSource(`/api/notifications/stream?projectId=${encodeURIComponent(projectId)}`)

  es.addEventListener(SseEventType.Connected, () => {
    retries = 0
    for (const sub of subscribers) sub.onConnect?.()
  })

  const eventTypes = [
    TaskNotificationEventType.TaskStarted,
    TaskNotificationEventType.TaskProgress,
    TaskNotificationEventType.TaskCompleted,
    TaskNotificationEventType.TaskFailed,
    TaskNotificationEventType.WikiSnapshot,
  ]
  for (const type of eventTypes) {
    es.addEventListener(type, (e: MessageEvent) => {
      for (const sub of subscribers) sub.events?.[type]?.(e)
    })
  }

  es.onerror = () => {
    es?.close()
    es = null
    scheduleReconnect(projectId)
  }
}

function scheduleReconnect(projectId: string) {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** retries, RECONNECT_MAX_MS)
  retries++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (subscribers.size > 0) connect(projectId)
  }, delay)
}

export function subscribe(projectId: string, sub: Subscription): () => void {
  subscribers.add(sub)
  if (currentProjectId !== projectId) {
    es?.close()
    es = null
    currentProjectId = null
  }
  if (subscribers.size >= 1) connect(projectId)
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) {
      es?.close()
      es = null
      currentProjectId = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      retries = 0
    }
  }
}

export type { Subscription }
