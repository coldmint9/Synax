import type { LlmRetryState } from '../../../../api/services/llm-runtime/retry-state'
export type { LlmRetryState } from '../../../../api/services/llm-runtime/retry-state'
import { AuthenticatedEventSource } from './authenticatedEventSource'
import { useApiConnectivityStore } from '../apiConnectivity'
import { RuntimeStreamProjector, type RuntimeSnapshot, type RuntimeStreamRecord } from './runtimeStream'
import type { AgentRunStep, AgentSession, ToolCallRecord } from './agentRuntime'

export type SessionLiveEvent =
  | { type: 'retry_status'; stepId: string; retry: LlmRetryState }
  | { type: 'runtime_state'; sessionId: string; patch: Partial<AgentSession>; reset: boolean; refresh: boolean }
  | { type: 'step_started'; stepId: string; stepIndex: number; step?: AgentRunStep }
  | { type: 'message_delta'; stepId: string; delta: string }
  | { type: 'thought_delta'; stepId: string; delta: string }
  | { type: 'tool_call'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'tool_result'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'context_compaction_started' }
  | { type: 'context_compacted'; stepId: string; originalTokens: number; compressedTokens: number; messageCount: number }
  | { type: 'context_compaction_failed'; error: string }

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
  for (const type of ['context_compaction_started', 'context_compacted', 'context_compaction_failed'] as const) {
    es.addEventListener(type, (event: MessageEvent) => {
      try { onEvent(JSON.parse(event.data) as SessionLiveEvent) }
      catch (error) { console.error(`Invalid ${type} event`, error) }
    })
  }
  es.onerror = (event) => {
    // CONNECTING is a recoverable observation failure; AuthenticatedEventSource reconnects and receives a fresh snapshot.
    if (es.readyState === AuthenticatedEventSource.CLOSED) { es.close(); onError?.(event) }
  }
  return () => es.close()
}
