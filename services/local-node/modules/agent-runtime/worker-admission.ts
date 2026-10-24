import { WorkerLifecycle } from "./worker-lifecycle.js";
import { WorkerQueue } from "./worker-queue.js";
import type { WorkerLease } from "./worker-types.js";

export class WorkerAdmission {
  readonly lifecycle = new WorkerLifecycle();
  readonly queue = new WorkerQueue();
  constructor(readonly capacity: number) {}
  canStart(sessionId: string | undefined, physicalCount: number, eligible: (id: string) => boolean): boolean {
    if (sessionId && !eligible(sessionId)) return false;
    const phase = sessionId ? this.lifecycle.phase(sessionId) : "absent";
    if (phase === "idle") return true;
    if (phase !== "absent") return false;
    const first = this.queue.first(eligible);
    return physicalCount < this.capacity && (!first || first === sessionId);
  }
  /** Only admission chooses idle eviction. Grey rollout is capped at one. */
  evictions(pressure = false): WorkerLease[] {
    const configured = Number(process.env.SYNAX_IDLE_WORKER_MAX ?? 0);
    const keep = pressure ? 0 : Number.isFinite(configured) ? Math.max(0, Math.min(1, Math.floor(configured))) : 0;
    const idle = this.lifecycle.idleLeases().filter(lease => lease.evictable !== false);
    return idle.slice(0, Math.max(0, idle.length - keep));
  }
}
