import type { FirstTokenTiming } from '../../../../packages/runtime-protocol/first-token-timing';
export interface ClientFirstTokenTiming extends FirstTokenTiming {
  sessionId: string;
  runId: string;
  stepId: string;
  clientReceivedAt: number;
  clientPaintAt?: number;
}
const samples = new Map<string, ClientFirstTokenTiming>();
export function receiveFirstToken(sample: ClientFirstTokenTiming): void {
  if (samples.has(sample.stepId)) return;
  samples.set(sample.stepId, sample);
  if (samples.size > 128) samples.delete(samples.keys().next().value!);
  window.dispatchEvent(new CustomEvent('synax:first-token', { detail: sample }));
}
export function paintFirstToken(stepId: string): void {
  const sample = samples.get(stepId);
  if (!sample || sample.clientPaintAt) return;
  sample.clientPaintAt = Date.now();
  window.dispatchEvent(new CustomEvent('synax:first-token-painted', { detail: { ...sample } }));
}
