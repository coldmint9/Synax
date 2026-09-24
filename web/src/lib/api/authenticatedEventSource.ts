import { subscribeObservation } from './realtime'
import { getApiOrigin } from './originConfig'

/** EventSource-compatible observer over the shared authenticated WebSocket.
 * The server preserves SSE event names, IDs and snapshot semantics. */
export class AuthenticatedEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = AuthenticatedEventSource.CONNECTING
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  private stopped = false
  private release?: () => void
  constructor(readonly url: string) {
    queueMicrotask(() => {
      if (this.stopped) return
      try {
        const expected = getApiOrigin() || window.location.origin
        const parsed = new URL(url, expected)
        if (parsed.origin !== expected || !parsed.pathname.startsWith('/api/')) throw new Error('Invalid observation origin.')
        this.release = subscribeObservation(`${parsed.pathname}${parsed.search}`, notice => {
          if (this.stopped) return
          if (notice.type === 'open') {
            this.readyState = AuthenticatedEventSource.OPEN
            this.onopen?.(new Event('open'))
          } else if (notice.type === 'event') {
            const event = new MessageEvent(notice.event, { data: notice.data, lastEventId: notice.lastEventId ?? '' })
            if (notice.event === 'message') this.onmessage?.(event)
            for (const listener of this.listeners.get(notice.event) ?? []) listener(event)
          } else {
            if (notice.type === 'error' && !notice.retryable) this.close()
            else this.readyState = AuthenticatedEventSource.CONNECTING
            // Observation failures are not proof that every HTTP endpoint is offline.
            this.onerror?.(new Event('error'))
          }
        })
      } catch {
        this.close()
        this.onerror?.(new Event('error'))
      }
    })
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void { this.listeners.get(type)?.delete(listener) }
  close(): void {
    this.stopped = true
    this.readyState = AuthenticatedEventSource.CLOSED
    this.release?.(); this.release = undefined
    this.listeners.clear()
  }
}
