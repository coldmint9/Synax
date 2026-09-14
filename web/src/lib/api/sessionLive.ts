import { AuthenticatedEventSource } from './authenticatedEventSource'
import { useApiConnectivityStore } from '../apiConnectivity'
import { RuntimeStreamProjector, type RuntimeSnapshot, type RuntimeStreamRecord } from './runtimeStream'
import type { AgentSession, ToolCallRecord } from './agentRuntime'

export type SessionLiveEvent =
  | { type: 'runtime_state'; sessionId: string; patch: Partial<AgentSession>; reset: boolean; refresh: boolean }
  | { type: 'step_started'; stepId: string; stepIndex: number }
  | { type: 'message_delta'; stepId: string; delta: string }
  | { type: 'thought_delta'; stepId: string; delta: string }
  | { type: 'tool_call'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'tool_result'; stepId: string; toolCall: ToolCallRecord }

export function sessionLiveStream(
  sessionId: string,
  onEvent: (event: SessionLiveEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const projector = new RuntimeStreamProjector()
  const es = new AuthenticatedEventSource(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stream`)
  es.addEventListener('snapshot', (event: MessageEvent) => {
    try {
      useApiConnectivityStore.getState().markSuccess()
      for (const projected of projector.snapshot(JSON.parse(event.data) as RuntimeSnapshot)) onEvent(projected)
    } catch (error) { console.error('Invalid runtime snapshot', error) }
  })
  es.addEventListener('chunk', (event: MessageEvent) => {
    try { for (const projected of projector.record(JSON.parse(event.data) as RuntimeStreamRecord)) onEvent(projected) }
    catch (error) { console.error('Invalid runtime stream record', error) }
  })
  es.onerror = (event) => {
    useApiConnectivityStore.getState().markFailure()
    // CONNECTING is a recoverable observation failure; AuthenticatedEventSource reconnects and receives a fresh snapshot.
    if (es.readyState === AuthenticatedEventSource.CLOSED) { es.close(); onError?.(event) }
  }
  return () => es.close()
}
