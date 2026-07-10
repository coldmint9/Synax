import { useApiConnectivityStore } from '../apiConnectivity'
import type { ToolCallRecord } from './agentRuntime'

export type SessionLiveEvent =
  | { type: 'step_started'; stepId: string; stepIndex: number }
  | { type: 'message_delta'; stepId: string; delta: string }
  | { type: 'thought_delta'; stepId: string; delta: string }
  | { type: 'tool_call'; stepId: string; toolCall: ToolCallRecord }
  | { type: 'tool_result'; stepId: string; toolCall: ToolCallRecord }

const LIVE_EVENT_TYPES = new Set(['step_started', 'message_delta', 'thought_delta', 'tool_call', 'tool_result'])

export function sessionLiveStream(
  sessionId: string,
  onEvent: (event: SessionLiveEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  if (useApiConnectivityStore.getState().shouldSkipRequest()) {
    return () => {}
  }

  const es = new EventSource(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/live`)

  for (const eventType of LIVE_EVENT_TYPES) {
    es.addEventListener(eventType, (e: MessageEvent) => {
      try {
        onEvent(JSON.parse(e.data) as SessionLiveEvent)
      } catch { /* ignore parse errors */ }
    })
  }

  es.onerror = (event) => {
    // Close to stop browser EventSource auto-reconnect spam while API is down.
    es.close()
    useApiConnectivityStore.getState().markFailure()
    onError?.(event)
  }

  return () => es.close()
}
