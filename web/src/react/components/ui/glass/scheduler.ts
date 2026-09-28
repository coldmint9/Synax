export const MAX_CONTEXTS = 2;
export const MAX_SETTLE_MS = 300;

export interface FrameClock {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface ContextRequest {
  priority: "island" | "control";
  /** Synchronous cleanup; true confirms no context survives (including pending imports). */
  release(): boolean;
  acquire(): void;
}

export interface ContextLease {
  setEligible(eligible: boolean): void;
  dispose(): void;
}

type Draw = (time: number) => void;
type Entry = ContextRequest & { eligible: boolean; active: boolean; disposed: boolean; unreleased: boolean };

const browserClock: FrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** No timers or listeners until a consumer explicitly requests work. */
export function createGlassScheduler(clock: FrameClock = browserClock) {
  const subscribers = new Set<Draw>();
  const pending = new Map<Draw, number>();
  const contexts = new Set<Entry>();
  let raf: number | null = null;
  let visible = true;
  let balancing = false;
  let rebalanceAgain = false;
  // Unconfirmed releases remain charged for this scheduler's lifetime, even
  // after unmount. A count retains no surface, renderer, or React closures.
  let retainedContexts = 0;

  function cancelEmptyFrame() {
    if (!pending.size && raf !== null) {
      clock.cancel(raf);
      raf = null;
    }
  }

  function schedule() {
    if (visible && pending.size && raf === null) raf = clock.request(tick);
  }

  function tick(time: number) {
    raf = null;
    for (const [draw, until] of [...pending]) {
      if (!pending.has(draw) || !subscribers.has(draw)) continue;
      // Delete before drawing so a new request made inside draw is not lost.
      if (time >= until) pending.delete(draw);
      try { draw(time); } catch { pending.delete(draw); }
    }
    schedule();
  }

  function release(entry: Entry) {
    if (!entry.active) return;
    entry.active = false;
    let released = false;
    try { released = entry.release() === true; } catch { /* retain the reservation */ }
    if (!released) {
      retainedContexts++;
      entry.unreleased = true;
      rebalanceAgain = true;
    }
  }

  function rebalance() {
    if (balancing) { rebalanceAgain = true; return; }
    balancing = true;
    try {
      do {
        rebalanceAgain = false;
        // Stable order gives older islands priority without starving them on hover.
        const eligible = visible ? [...contexts].filter((entry) => entry.eligible && !entry.disposed && !entry.unreleased) : [];
        eligible.sort((a, b) => Number(b.priority === "island") - Number(a.priority === "island"));
        const chosen = new Set(eligible.slice(0, MAX_CONTEXTS - retainedContexts));
        // Revoke every displaced owner BEFORE any new context can be created.
        for (const entry of contexts) {
          if (entry.disposed || !chosen.has(entry)) release(entry);
          if (entry.disposed) contexts.delete(entry);
        }
        // A release may shrink the real budget or synchronously change priority.
        if (rebalanceAgain) continue;
        for (const entry of chosen) {
          if (entry.active || !entry.eligible || entry.disposed || !contexts.has(entry) || !visible) continue;
          entry.active = true;
          try { entry.acquire(); } catch {
            entry.eligible = false;
            release(entry);
            rebalanceAgain = true;
          }
          if (rebalanceAgain) break;
        }
      } while (rebalanceAgain);
    } finally { balancing = false; }
  }

  return {
    now: clock.now,
    subscribe(draw: Draw): () => void {
      subscribers.add(draw);
      return () => {
        subscribers.delete(draw);
        pending.delete(draw);
        cancelEmptyFrame();
      };
    },
    request(draw: Draw, settleMs = 0) {
      if (!visible || !subscribers.has(draw)) return;
      const duration = Number.isFinite(settleMs) ? Math.min(MAX_SETTLE_MS, Math.max(0, settleMs)) : 0;
      const until = clock.now() + duration;
      pending.set(draw, Math.max(pending.get(draw) ?? -Infinity, until));
      schedule();
    },
    cancel(draw: Draw) {
      pending.delete(draw);
      cancelEmptyFrame();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (!visible) { pending.clear(); cancelEmptyFrame(); }
      rebalance();
    },
    registerContext(request: ContextRequest): ContextLease {
      const entry: Entry = { ...request, eligible: false, active: false, disposed: false, unreleased: false };
      contexts.add(entry);
      return {
        setEligible(eligible) {
          if (!contexts.has(entry) || entry.disposed || entry.eligible === eligible) return;
          entry.eligible = eligible;
          rebalance();
        },
        dispose() {
          if (!contexts.has(entry) || entry.disposed) return;
          entry.disposed = true;
          entry.eligible = false;
          // Cleanup runs under the rebalance guard. A reentrant registration
          // cannot borrow this slot before physical disposal has finished.
          rebalance();
        },
      };
    },
  };
}

export type GlassScheduler = ReturnType<typeof createGlassScheduler>;
