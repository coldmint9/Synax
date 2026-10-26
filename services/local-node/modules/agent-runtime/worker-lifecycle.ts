import type { WorkerLease, WorkerPhase } from "./worker-types.js";

/** Physical capacity is released only by confirmed exit, never by kill/send. */
export class WorkerLifecycle {
  private generation = 0;
  private leases = new Map<string, WorkerLease>();
  get physicalCount(): number {
    return [...this.leases.values()].filter(lease => lease.phase !== "recovering").length;
  }
  phase(sessionId: string): WorkerPhase { return this.leases.get(sessionId)?.phase ?? "absent"; }
  current(lease: WorkerLease): boolean { return this.leases.get(lease.sessionId) === lease; }
  start(sessionId: string): WorkerLease {
    if (this.leases.has(sessionId)) throw new Error("Worker still owns this session.");
    const lease: WorkerLease = { sessionId, generation: ++this.generation, phase: "starting" };
    this.leases.set(sessionId, lease);
    return lease;
  }
  running(lease: WorkerLease): void {
    if (!this.current(lease) || !["starting", "idle"].includes(lease.phase)) throw new Error("Worker lease is unavailable.");
    lease.phase = "running"; lease.idleAt = undefined;
  }
  idle(lease: WorkerLease): void {
    if (!this.current(lease) || lease.phase !== "running") return;
    lease.phase = "idle"; lease.idleAt = Date.now();
  }
  release(lease: WorkerLease): void {
    if (this.current(lease) && lease.phase !== "recovering") lease.phase = "releasing";
  }
  exited(lease: WorkerLease): void { if (this.current(lease)) lease.phase = "recovering"; }
  recovered(lease: WorkerLease): void { if (this.current(lease)) this.leases.delete(lease.sessionId); }
  idleLeases(): WorkerLease[] {
    return [...this.leases.values()].filter(lease => lease.phase === "idle").sort((a, b) => (a.idleAt ?? 0) - (b.idleAt ?? 0));
  }
}
