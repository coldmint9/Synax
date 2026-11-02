import { sessionLiveStream, type SessionLiveEvent } from './sessionLive'
import type { RunRealtimeCheckpoint } from './runRealtime'

type LiveHandler = (event: SessionLiveEvent) => void
interface LiveConnection { handlers: Set<LiveHandler>; close: () => void; generation: number; live: boolean }
const connections = new Map<string, LiveConnection>()
let activeSessionId: string | null = null
let activeRelease: (() => void) | null = null

function connect(sessionId: string, connection: LiveConnection, resume?: RunRealtimeCheckpoint): void {
  // A healthy connection already fans out to every attached handler; tearing it
  // down per subscriber costs a snapshot round-trip and a refresh storm.
  if (connection.live) return
  connection.close()
  const generation = ++connection.generation
  connection.live = true
  connection.close = sessionLiveStream(sessionId, event => {
    if (connection.generation !== generation) return
    for (const handler of connection.handlers) {
      try { handler(event) }
      catch (error) { console.error('Session observer failed', error) }
    }
  }, () => {
    if (connection.generation !== generation || connections.get(sessionId) !== connection) return
    connection.live = false
    connections.delete(sessionId)
    if (activeSessionId === sessionId) { activeSessionId = null; activeRelease = null }
  }, resume)
}

function subscribeSessionLive(sessionId: string, handler: LiveHandler, resume?: RunRealtimeCheckpoint): () => void {
  let connection = connections.get(sessionId)
  // A dock may have kept the shared reader ahead while this transcript was
  // away. Resume this reader's cursor independently on the same physical WS;
  // joining the fan-out would silently skip its missing records.
  if (resume && connection?.live) return sessionLiveStream(sessionId, handler, undefined, resume)
  if (!connection) {
    connection = { handlers: new Set(), close: () => {}, generation: 0, live: false }
    connections.set(sessionId, connection)
  }
  connection.handlers.add(handler)
  // A fresh connection replays a server snapshot; concurrent subscribers on a
  // live connection just join its event fan-out.
  connect(sessionId, connection, resume)
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
export function addSessionLiveListener(sessionId: string, handler: LiveHandler, options?: { replaySnapshot?: boolean }): () => void {
  // A transcript joining a Dock observer needs its own snapshot. Fan-out only
  // carries future deltas and cannot reconstruct the step already in flight.
  // Runtime transports multiplex readers over the shared physical connection.
  if (options?.replaySnapshot && connections.get(sessionId)?.live)
    return sessionLiveStream(sessionId, handler);
  return subscribeSessionLive(sessionId, handler)
}
export function ensureSessionLiveSubscription(sessionId: string, handler: LiveHandler, resume?: RunRealtimeCheckpoint): void {
  if (activeSessionId === sessionId && activeRelease) return
  releaseSessionLiveSubscription()
  activeSessionId = sessionId
  activeRelease = subscribeSessionLive(sessionId, handler, resume)
}
export function releaseSessionLiveSubscription(): void {
  activeRelease?.(); activeRelease = null; activeSessionId = null
}
