import { sessionLiveStream, type SessionLiveEvent } from './sessionLive'

type LiveHandler = (event: SessionLiveEvent) => void
interface LiveConnection { handlers: Set<LiveHandler>; close: () => void; generation: number; live: boolean }
const connections = new Map<string, LiveConnection>()
let activeSessionId: string | null = null
let activeRelease: (() => void) | null = null

function connect(sessionId: string, connection: LiveConnection): void {
  // A healthy connection already fans out to every attached handler; tearing it
  // down per subscriber costs a snapshot round-trip and a refresh storm.
  if (connection.live) return
  connection.close()
  const generation = ++connection.generation
  connection.live = true
  connection.close = sessionLiveStream(sessionId, event => {
    if (connection.generation !== generation) return
    for (const handler of connection.handlers) handler(event)
  }, () => {
    if (connection.generation !== generation || connections.get(sessionId) !== connection) return
    connection.live = false
    connections.delete(sessionId)
    if (activeSessionId === sessionId) { activeSessionId = null; activeRelease = null }
  })
}

function subscribeSessionLive(sessionId: string, handler: LiveHandler): () => void {
  let connection = connections.get(sessionId)
  if (!connection) {
    connection = { handlers: new Set(), close: () => {}, generation: 0, live: false }
    connections.set(sessionId, connection)
  }
  connection.handlers.add(handler)
  // A fresh connection replays a server snapshot; concurrent subscribers on a
  // live connection just join its event fan-out.
  connect(sessionId, connection)
  return () => {
    connection!.handlers.delete(handler)
    if (connection!.handlers.size === 0) {
      ++connection!.generation
      connection!.live = false
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
