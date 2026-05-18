import type {
  CoordinatesRunEvent,
  CursorAgentAdapter,
  DispatchIntentInput,
  DispatchIntentResult,
  ProviderId,
} from '../contracts'
import { apiFetch } from '../../api/origin'

/**
 * Parses an SSE (text/event-stream) ReadableStream into an AsyncIterable of
 * CoordinatesRunEvent. Terminates when it encounters a `[DONE]` data line or
 * the stream closes.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<CoordinatesRunEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE lines are separated by \n; a blank line ends an event block.
      // Hono's writeSSE emits: "data: {json}\n\n"
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop()!

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as CoordinatesRunEvent
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export class CursorAcpApiAdapter implements CursorAgentAdapter {
  providerId: ProviderId

  constructor(providerId: ProviderId = 'opencode-acp') {
    this.providerId = providerId
  }

  async dispatchIntent(input: DispatchIntentInput): Promise<DispatchIntentResult> {
    const response = await apiFetch('/api/coordinates/dispatch/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error((body as any).error ?? `dispatch failed (${response.status})`)
    }

    if (!response.body) {
      throw new Error('Server returned no response body for streaming request')
    }

    return {
      // runId is extracted from the first run_started event inside consumeRunEvents;
      // the store creates its own runId so this placeholder is never read.
      runId: '',
      provider: this.providerId,
      events: parseSSEStream(response.body),
    }
  }
}
