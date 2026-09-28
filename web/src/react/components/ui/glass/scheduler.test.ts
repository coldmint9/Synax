import { describe, expect, it, vi } from "vitest";
import { createGlassScheduler, MAX_CONTEXTS, MAX_SETTLE_MS } from "./scheduler";
import { createFrameClock } from "./__tests__/helpers";

describe("glass scheduler", () => {
  it("shares one RAF, coalesces requests, and schedules zero idle frames", () => {
    const clock = createFrameClock();
    const scheduler = createGlassScheduler(clock);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = scheduler.subscribe(first);
    scheduler.subscribe(second);
    expect(clock.pending()).toBe(0);
    scheduler.request(first);
    scheduler.request(first);
    scheduler.request(second);
    expect(clock.pending()).toBe(1);
    clock.flush(16);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    scheduler.request(first);
    unsubscribe();
    expect(clock.pending()).toBe(0);
    scheduler.request(first);
    expect(clock.pending()).toBe(0);
  });

  it("caps settling at 300ms and cancels queued work when hidden", () => {
    const clock = createFrameClock();
    const scheduler = createGlassScheduler(clock);
    const draw = vi.fn();
    scheduler.subscribe(draw);
    scheduler.request(draw, 10_000);
    clock.flush(100);
    expect(clock.pending()).toBe(1);
    clock.flush(MAX_SETTLE_MS);
    expect(clock.pending()).toBe(0);
    scheduler.request(draw, 100);
    scheduler.setVisible(false);
    expect(clock.pending()).toBe(0);
    scheduler.request(draw);
    expect(clock.pending()).toBe(0);
    scheduler.setVisible(true);
    expect(clock.pending()).toBe(0);
    scheduler.request(draw);
    clock.flush(400);
    expect(draw).toHaveBeenCalledTimes(3);
  });

  it("cancels just one surface without starving the others", () => {
    const clock = createFrameClock();
    const scheduler = createGlassScheduler(clock);
    const first = vi.fn();
    const second = vi.fn();
    scheduler.subscribe(first);
    scheduler.subscribe(second);
    scheduler.request(first, 300);
    scheduler.request(second);
    scheduler.cancel(first);
    clock.flush(16);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
  });

  it("never grants over two contexts, revokes controls before granting islands, and resumes waiters", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    let active = 0;
    let peak = 0;
    const events: string[] = [];
    const register = (name: string, priority: "island" | "control") => scheduler.registerContext({
      priority,
      acquire: () => { active++; peak = Math.max(peak, active); events.push(`+${name}`); },
      release: () => { active--; events.push(`-${name}`); return true; },
    });
    const a = register("a", "control");
    const b = register("b", "control");
    const island = register("island", "island");
    const waiting = register("waiting", "island");
    a.setEligible(true);
    b.setEligible(true);
    island.setEligible(true);
    waiting.setEligible(true);
    expect(peak).toBe(MAX_CONTEXTS);
    expect(active).toBe(2);
    expect(events.indexOf("-b")).toBeLessThan(events.indexOf("+island"));
    expect(events.indexOf("-a")).toBeLessThan(events.indexOf("+waiting"));
    island.dispose();
    expect(active).toBe(2);
    expect(events[events.length - 1]).toBe("+a");
    a.dispose(); b.dispose(); waiting.dispose(); waiting.dispose();
    expect(active).toBe(0);
  });

  it("suspends all leases while hidden and safely handles a failed acquisition", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    const acquire = vi.fn();
    const release = vi.fn(() => true);
    const lease = scheduler.registerContext({ priority: "island", acquire, release });
    lease.setEligible(true);
    scheduler.setVisible(false);
    expect(release).toHaveBeenCalledOnce();
    scheduler.setVisible(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    lease.dispose();
    const broken = scheduler.registerContext({
      priority: "island", acquire: () => { throw new Error("driver failed"); }, release: vi.fn(() => true),
    });
    expect(() => broken.setEligible(true)).not.toThrow();
    broken.dispose();
  });

  it.each(["unconfirmed", "throws"] as const)("keeps reservations after %s release, including unmount and later registration", (mode) => {
    const scheduler = createGlassScheduler(createFrameClock());
    let live = 0;
    let peak = 0;
    const register = (priority: "control" | "island") => scheduler.registerContext({
      priority,
      acquire: () => { live++; peak = Math.max(peak, live); },
      release: () => {
        if (mode === "throws") throw new Error("context not released");
        return false;
      },
    });
    const a = register("control"), b = register("control"), island = register("island");
    a.setEligible(true); b.setEligible(true); island.setEligible(true);
    expect(peak).toBe(2);
    expect(live).toBe(2);
    a.dispose(); b.dispose(); island.dispose();
    const later = register("island");
    later.setEligible(true);
    scheduler.setVisible(false); scheduler.setVisible(true);
    expect(live).toBe(2);
    later.dispose();
  });

  it("does not lend a slot during a reentrant release before physical disposal completes", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    let live = 0;
    let peak = 0;
    const acquire = () => { live++; peak = Math.max(peak, live); };
    const release = () => { live--; return true; };
    const successor = scheduler.registerContext({ priority: "island", acquire, release });
    const a = scheduler.registerContext({
      priority: "control", acquire,
      release: () => { successor.setEligible(true); return release(); },
    });
    const b = scheduler.registerContext({ priority: "control", acquire, release });
    a.setEligible(true); b.setEligible(true);
    a.dispose();
    expect(peak).toBe(2);
    expect(live).toBe(2);
    b.dispose(); successor.dispose();
    expect(live).toBe(0);
  });

  it("rebalances island priority against reservations that cannot be released", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    let live = 0;
    let peak = 0;
    const acquire = vi.fn(() => { live++; peak = Math.max(peak, live); });
    const release = vi.fn(() => { live--; return true; });
    const a = scheduler.registerContext({ priority: "control", acquire, release });
    const b = scheduler.registerContext({ priority: "control", acquire, release: () => false });
    const islandAcquire = vi.fn(() => acquire());
    const island = scheduler.registerContext({ priority: "island", acquire: islandAcquire, release });
    a.setEligible(true); b.setEligible(true); island.setEligible(true);
    expect(islandAcquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(peak).toBe(2);
    island.dispose();
    expect(live).toBe(2); // A can use the spare slot; B's reservation remains.
    a.dispose(); b.dispose();
    expect(live).toBe(1);
  });

  it("requires positive confirmation rather than an undefined release result", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    const acquire = vi.fn();
    const release = vi.fn<() => boolean>(); // A broken implementation returns undefined.
    for (let i = 0; i < 3; i++) {
      const lease = scheduler.registerContext({ priority: "island", acquire, release });
      lease.setEligible(true);
      lease.dispose();
    }
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases an active chosen owner disposed reentrantly by another owner's cleanup", () => {
    const scheduler = createGlassScheduler(createFrameClock());
    let live = 0;
    let peak = 0;
    const acquire = () => { live++; peak = Math.max(peak, live); };
    const release = () => { live--; return true; };
    const control = scheduler.registerContext({
      priority: "control", acquire,
      release: () => { activeIsland.dispose(); return release(); },
    });
    const activeIsland = scheduler.registerContext({ priority: "island", acquire, release });
    const nextIsland = scheduler.registerContext({ priority: "island", acquire, release });
    const lastIsland = scheduler.registerContext({ priority: "island", acquire, release });
    control.setEligible(true); activeIsland.setEligible(true);
    nextIsland.setEligible(true); lastIsland.setEligible(true);
    expect(live).toBe(2);
    expect(peak).toBe(2);
    control.dispose(); activeIsland.dispose(); nextIsland.dispose(); lastIsland.dispose();
    expect(live).toBe(0);
  });

});
