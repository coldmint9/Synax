import { sessionLiveStream, type SessionLiveEvent } from './sessionLive'

type LiveHandler = (event: SessionLiveEvent) => void

interface LiveConnection {
  handlers: Set<LiveHandler>
  close: () => void
}

const connections = new Map<string, LiveConnection>()

let activeSessionId: string | null = null
let activeRelease: (() => void) | null = null

function subscribeSessionLive(sessionId: string, handler: LiveHandler): () => void {
  let connection = connections.get(sessionId)
  if (!connection) {
    const handlers = new Set<LiveHandler>()
    const close = sessionLiveStream(sessionId, (event) => {
      for (const h of handlers) h(event)
    })
    connection = { handlers, close }
    connections.set(sessionId, connection)
  }

  connection.handlers.add(handler)
  return () => {
    connection!.handlers.delete(handler)
    if (connection!.handlers.size === 0) {
      connection!.close()
      connections.delete(sessionId)
    }
  }
}

export function addSessionLiveListener(sessionId: string, handler: LiveHandler): () => void {
  return subscribeSessionLive(sessionId, handler)
}

export function ensureSessionLiveSubscription(sessionId: string, handler: LiveHandler): void {
  if (activeSessionId === sessionId && activeRelease) return
  releaseSessionLiveSubscription()
  activeSessionId = sessionId
  activeRelease = subscribeSessionLive(sessionId, handler)
}

export function releaseSessionLiveSubscription(): void {
  activeRelease?.()
  activeRelease = null
  activeSessionId = null
}
