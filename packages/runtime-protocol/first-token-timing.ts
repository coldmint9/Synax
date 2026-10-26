/** Wall-clock boundaries; provider time is supplied only by an instrumented provider. */
export interface FirstTokenTiming {
  providerFirstTokenAt?: number;
  rustFirstTokenAt?: number;
  nodeFirstTokenAt?: number;
  realtimeEnqueueAt?: number;
}

