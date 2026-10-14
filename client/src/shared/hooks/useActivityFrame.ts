import { useSyncExternalStore } from 'react';
import { useApiConnectivityStore } from '../lib/apiConnectivity';

// All status icons share one 2Hz clock. No per-cell CSS animation, per-icon
// interval, or frame-rate rendering; hidden/disconnected pages have no timer.
let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let stop: (() => void) | undefined;
const listeners = new Set<() => void>();
const snapshot = () => frame;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const sync = () => {
      const state = useApiConnectivityStore.getState();
      const active = !document.hidden && state.browserOnline && state.apiReachable !== 'unreachable' && !motion?.matches;
      if (!active && timer !== undefined) { clearInterval(timer); timer = undefined; }
      if (active && timer === undefined) timer = setInterval(() => {
        frame = (frame + 1) % 4;
        for (const notify of listeners) notify();
      }, 500);
    };
    const unsubscribe = useApiConnectivityStore.subscribe(sync);
    document.addEventListener('visibilitychange', sync);
    motion?.addEventListener('change', sync);
    sync();
    stop = () => {
      clearInterval(timer); timer = undefined;
      unsubscribe();
      document.removeEventListener('visibilitychange', sync);
      motion?.removeEventListener('change', sync);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = undefined; }
  };
}

export function useActivityFrame() {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
