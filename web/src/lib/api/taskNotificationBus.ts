import { AuthenticatedEventSource } from './authenticatedEventSource'
import { SseEventType, TaskNotificationEventType } from './eventTypes'

type EventHandler = (e: MessageEvent) => void
type ConnectHandler = () => void

interface Subscription {
  events?: Partial<Record<string, EventHandler>>
  onConnect?: ConnectHandler
}

let es: AuthenticatedEventSource | null = null
let subscribers = new Set<Subscription>()
let currentProjectId: string | null = null

function connect(projectId: string) {
  if (es && es.readyState !== AuthenticatedEventSource.CLOSED) return
  currentProjectId = projectId
  es = new AuthenticatedEventSource(`/api/notifications/stream?projectId=${encodeURIComponent(projectId)}`)

  es.addEventListener(SseEventType.Connected, () => {
    for (const sub of subscribers) sub.onConnect?.()
  })

  const eventTypes = [
    TaskNotificationEventType.TaskStarted,
    TaskNotificationEventType.TaskProgress,
    TaskNotificationEventType.TaskCompleted,
    TaskNotificationEventType.TaskFailed,
    TaskNotificationEventType.WikiSnapshot,
    TaskNotificationEventType.DocumentCommitted,
  ]
  for (const type of eventTypes) {
    es.addEventListener(type, (e: MessageEvent) => {
      for (const sub of subscribers) sub.events?.[type]?.(e)
    })
  }

  const source = es
  source.onerror = () => {
    if (source.readyState === AuthenticatedEventSource.CLOSED && es === source) es = null
  }
}

export function subscribe(projectId: string, sub: Subscription): () => void {
  const alreadyOpen = es?.readyState === AuthenticatedEventSource.OPEN
  subscribers.add(sub)
  if (currentProjectId !== projectId) {
    es?.close()
    es = null
    currentProjectId = null
  }
  if (subscribers.size >= 1) connect(projectId)
  // Late subscribers miss the initial wiki_snapshot pushed on connect — refetch then.
  if (alreadyOpen && es?.readyState === AuthenticatedEventSource.OPEN) {
    queueMicrotask(() => sub.onConnect?.())
  }
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) {
      es?.close()
      es = null
      currentProjectId = null
    }
  }
}

export type { Subscription }
