import { describe, expect, it, vi } from 'vitest';
import { MergeWorkerWatchdog } from './worker-watchdog.js';
import type { RuntimeBusEvent } from '../runtime-bus.js';
function fixture() {
  const listeners = new Set<(event: RuntimeBusEvent) => void>();
  const supervisor = new MergeWorkerWatchdog({ subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; } });
  return { supervisor, listeners, emit: (event: RuntimeBusEvent) => { for (const listener of listeners) listener(event); } };
}
describe('merge worker progress deadline', () => {
  it('expires an idle stream once and releases its timer/listener before stopping', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, listeners } = fixture();
      const stop = vi.fn(async () => { expect(supervisor.size).toBe(0); expect(listeners.size).toBe(0); });
      const watch = supervisor.watch('child', stop, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await watch.expired).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1); expect(watch.timedOut).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('renews only genuine scoped progress, never heartbeat/status events or duplicate steps', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, emit } = fixture(), stop = vi.fn(async () => {});
      const watch = supervisor.watch('child', stop, 1000);
      await vi.advanceTimersByTimeAsync(500);
      emit({type:'session_step_completed',sessionId:'child',runId:'r',stepIndex:1});
      await vi.advanceTimersByTimeAsync(500);
      emit({type:'session_changed',sessionId:'child'});
      emit({type:'session_step_completed',sessionId:'child',runId:'r',stepIndex:1});
      emit({type:'session_step_completed',sessionId:'other',runId:'r',stepIndex:2});
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await watch.expired;
      expect(stop).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('shares one listener, isolates siblings, and disposes completed work', async () => {
    vi.useFakeTimers();
    try {
      const {supervisor,listeners}=fixture(), first=vi.fn(async()=>{}), second=vi.fn(async()=>{});
      const a=supervisor.watch('a',first,1000), b=supervisor.watch('b',second,1000);
      expect(listeners.size).toBe(1);
      a.dispose(); await vi.advanceTimersByTimeAsync(1000); await b.expired;
      expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
      expect(supervisor.size).toBe(0); expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
