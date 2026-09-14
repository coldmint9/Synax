import { sessionLiveStream, type SessionLiveEvent } from './sessionLive'

type LiveHandler = (event: SessionLiveEvent) => void
interface LiveConnection { handlers: Set<LiveHandler>; close: () => void; generation: number }
const connections = new Map<string, LiveConnection>()
let activeSessionId: string | null = null
let activeRelease: (() => void) | null = null

function connect(sessionId: string, connection: LiveConnection): void {
  connection.close()
  const generation = ++connection.generation
  connection.close = sessionLiveStream(sessionId, event => {
    if (connection.generation !== generation) return
    for (const handler of connection.handlers) handler(event)
  }, () => {
    if (connection.generation !== generation || connections.get(sessionId) !== connection) return
    connections.delete(sessionId)
    if (activeSessionId === sessionId) { activeSessionId = null; activeRelease = null }
  })
}

function subscribeSessionLive(sessionId: string, handler: LiveHandler): () => void {
  let connection = connections.get(sessionId)
  if (!connection) {
    connection = { handlers: new Set(), close: () => {}, generation: 0 }
    connections.set(sessionId, connection)
  }
  connection.handlers.add(handler)
  // A newly attached view needs a snapshot too; reconnecting observers never restarts the Run.
  connect(sessionId, connection)
  return () => {
    connection!.handlers.delete(handler)
    if (connection!.handlers.size === 0) {
      ++connection!.generation
      connection!.close()
      if (connections.get(sessionId) === connection) connections.delete(sessionId)
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
  activeRelease?.(); activeRelease = null; activeSessionId = null
}
