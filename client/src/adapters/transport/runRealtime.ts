import { receiveFirstToken } from "./firstTokenTiming";
import { AuthenticatedEventSource } from './authenticatedEventSource';
import { RuntimeStreamProjector, type RuntimeStreamRecord, type RuntimeProjectionCheckpoint } from './runtimeStream';
import type { SessionLiveEvent } from './sessionLive';

/** Submission notifications attach the visible session before its first token.
 * Other tabs discover runs through their normal durable snapshot/state feed. */
const listeners = new Map<string, Set<(runId: string | null) => void>>();
const activeObservations = new Map<string, Map<object, string>>();
const defaultObservationOwner = {};
export interface RunRealtimeCheckpoint {
  sessionId: string;
  runId: string;
  projection: RuntimeProjectionCheckpoint;
}
// Only connected readers live here. The session cache owns detached snapshots
// and their matching cursors, so evicting content also evicts its resume point.
const checkpoints = new Map<string, { runId: string; projector: RuntimeStreamProjector }>();
export function captureRunRealtimeCheckpoint(sessionId: string): RunRealtimeCheckpoint | undefined {
  const current = checkpoints.get(sessionId);
  return current ? { sessionId, runId: current.runId, projection: current.projector.checkpoint() } : undefined;
}
export const hasRunRealtimeObservation = (sessionId: string) => activeObservations.has(sessionId);
export function setRunRealtimeObservation(sessionId: string, runId: string | null, owner = defaultObservationOwner): void {
  const observations = activeObservations.get(sessionId) ?? new Map<object, string>();
  if (runId) observations.set(owner, runId); else observations.delete(owner);
  if (observations.size) activeObservations.set(sessionId, observations); else activeObservations.delete(sessionId);
}
export function announceRunObservation(sessionId: string, runId: string | null): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(runId);
}
export function onRunObservation(sessionId: string, listener: (runId: string | null) => void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener); listeners.set(sessionId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(sessionId); };
}

export function observeRunRealtime(sessionId: string, runId: string,
  onEvent: (event: SessionLiveEvent) => void, recover: () => void, resume?: RunRealtimeCheckpoint): () => void {
  const projector = new RuntimeStreamProjector();
  if (resume?.sessionId === sessionId && resume.runId === runId) projector.restore(resume.projection);
  let cursor = projector.checkpoint().cursor;
  const source = new AuthenticatedEventSource(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/stream?realtime=1`,
    cursor > 0 ? { cursor: String(cursor) } : undefined);
  const checkpoint = { runId, projector };
  checkpoints.set(sessionId, checkpoint);
  let closed = false;
  const close = () => {
    closed = true; source.close();
    if (checkpoints.get(sessionId) === checkpoint) checkpoints.delete(sessionId);
  };
  const reset = () => { if (!closed) { close(); recover(); } };
  source.addEventListener('realtime_reset', reset);
  source.onmessage = event => {
    if (closed) return;
    if (event.data === '[DONE]') {
      window.dispatchEvent(new CustomEvent('synax:run-complete', { detail: { sessionId, runId } }));
      reset(); return;
    }
    try {
      const record = JSON.parse(event.data) as RuntimeStreamRecord;
      if (record.runId !== runId || record.sessionId !== sessionId) throw new Error('Run identity mismatch.');
      if (record.sequence <= cursor) return;
      if (record.sequence !== cursor + 1) throw new Error('Run realtime sequence gap.');
      cursor = record.sequence;
      const chunk = record.chunk;
      if (['run_completed', 'run_failed', 'done'].includes(chunk.type)) {
        // Notify before projecting terminal state: its React subscriber may
        // unmount the observation immediately after rendering completion.
        window.dispatchEvent(new CustomEvent('synax:run-complete', { detail: { sessionId, runId } }));
      }
      if (chunk.type === 'message_delta' && chunk.delta && chunk.stepId) {
        receiveFirstToken({
          sessionId, runId, stepId: chunk.stepId,
          ...chunk.firstTokenTiming, clientReceivedAt: Date.now(),
        });
      }
      for (const projected of projector.record(record)) onEvent(projected);
    } catch { reset(); }
  };
  source.onerror = () => { if (source.readyState === AuthenticatedEventSource.CLOSED) reset(); };
  return close;
}
