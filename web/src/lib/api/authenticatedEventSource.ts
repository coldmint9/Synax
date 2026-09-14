import { apiFetch } from './origin'

/** Fetch-based SSE works with desktop bearer credentials without putting secrets in URLs. */
export class AuthenticatedEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = AuthenticatedEventSource.CONNECTING
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private attempts = 0
  private lastId = ''
  constructor(readonly url: string) { queueMicrotask(() => { void this.connect() }) }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void { this.listeners.get(type)?.delete(listener) }
  close(): void {
    this.stopped = true; this.readyState = AuthenticatedEventSource.CLOSED
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort()
  }
  private frame(text: string): void {
    let type = 'message'; const data: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') type = value
      if (field === 'data') data.push(value)
      if (field === 'id' && !value.includes('\0')) this.lastId = value
    }
    if (!data.length) return
    const event = new MessageEvent(type, { data: data.join('\n'), lastEventId: this.lastId })
    if (type === 'message') this.onmessage?.(event)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  private async connect(): Promise<void> {
    if (this.stopped) return
    this.controller = new AbortController()
    try {
      const response = await apiFetch(this.url, { signal: this.controller.signal,
        headers: { Accept: 'text/event-stream', ...(this.lastId ? { 'Last-Event-ID': this.lastId } : {}) } })
      if (this.stopped) { await response.body?.cancel(); return }
      if (!response.ok || !response.body) {
        if ([401, 403, 404].includes(response.status)) { this.close(); this.onerror?.(new Event('error')); return }
        throw new Error(`Runtime event stream failed (${response.status}).`)
      }
      this.readyState = AuthenticatedEventSource.OPEN; this.attempts = 0; this.onopen?.(new Event('open'))
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      try {
        while (!this.stopped) {
          const { value, done } = await reader.read(); if (done) break
          buffer += decoder.decode(value, { stream: true })
          let match = /\r?\n\r?\n/.exec(buffer)
          while (match) { this.frame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); match = /\r?\n\r?\n/.exec(buffer) }
          if (buffer.length > 8 * 1024 * 1024) throw new Error('Runtime event frame exceeds the supported size.')
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (!this.stopped) throw new Error('Runtime event stream disconnected.')
    } catch {
      if (this.stopped) return
      this.readyState = AuthenticatedEventSource.CONNECTING; this.onerror?.(new Event('error'))
      if (!this.stopped) this.timer = setTimeout(() => { void this.connect() }, Math.min(1000 * 2 ** this.attempts++, 15_000))
    }
  }
}
