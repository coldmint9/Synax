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
  get idleLimit(): number {
    const configured = Number(process.env.SYNAX_IDLE_WORKER_MAX ?? 3);
    return Math.min(this.capacity, Number.isFinite(configured) ? Math.max(0, Math.min(3, Math.floor(configured))) : 3);
  }
  /** Keep the three most recently used idle sessions; queued work has priority. */
  evictions(pressure = false): WorkerLease[] {
    const keep = pressure ? 0 : this.idleLimit;
    const idle = this.lifecycle.idleLeases().filter(lease => lease.evictable !== false);
    return idle.slice(0, Math.max(0, idle.length - keep));
  }
}
