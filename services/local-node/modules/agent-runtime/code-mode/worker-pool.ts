import { Worker } from "node:worker_threads";
import { AsyncResource } from "node:async_hooks";
import { runtimeAsset } from "../../../infrastructure/runtime/runtime-paths.js";
import { CODE_WORKER_CAPACITY, CODE_WORKER_REUSE } from "./contracts.js";

interface Slot {
  worker: Worker;
  state: "leased" | "idle" | "retiring";
  uses: number;
  idleOrder: number;
  timer?: ReturnType<typeof setTimeout>;
  exited: Promise<void>;
  onExit: () => void;
  cancelLease?: () => void;
}

export interface CodeWorkerLease {
  worker: Worker;
  runId: number;
  signal: AbortSignal;
  /** Reuse only a successful execution whose sandbox has already been disposed. */
  release(reuse?: { wasmBytes: number }): Promise<void>;
}
type Admission =
  | { status: "acquired"; lease: CodeWorkerLease }
  | { status: "cancelled" | "timed_out" | "unavailable"; error: string };
interface Waiter {
  signal?: AbortSignal;
  deadline: number;
  finish(result: Admission): void;
}
interface PoolOptions {
  maxWorkers?: number;
  maxWaiting?: number;
  maxIdle?: number;
  idleTimeoutMs?: number;
  maxUses?: number;
  maxWasmBytes?: number;
  /** Infrastructure injection for lifecycle tests. Never supplied by model input. */
  createWorker?: () => Worker;
}

function createWorker(): Worker {
  return new Worker(runtimeAsset(import.meta.url, "./worker.mjs", "workers/code-mode.cjs"), {
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
}

/** Owns threads, leases and FIFO waiters. Retiring threads still count against
 * capacity until their exit is confirmed. Idle threads never keep Node alive. */
export class CodeWorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly waiting: Waiter[] = [];
  private readonly options: Required<PoolOptions>;
  private closed = false;
  private sequence = 0;
  private idleSequence = 0;
  private created = 0;
  private reused = 0;
  private readonly context = new AsyncResource("SynaxCodeModePool");
  private closing?: Promise<void>;

  constructor(options: PoolOptions = {}) {
    this.options = {
      maxWorkers: CODE_WORKER_CAPACITY.active, maxWaiting: CODE_WORKER_CAPACITY.waiting,
      maxIdle: CODE_WORKER_REUSE.idle, idleTimeoutMs: CODE_WORKER_REUSE.idleTimeoutMs,
      maxUses: CODE_WORKER_REUSE.maxUses, maxWasmBytes: CODE_WORKER_REUSE.maxWasmBytes,
      createWorker, ...options,
    };
    for (const key of ["maxWorkers", "maxWaiting", "maxUses", "maxWasmBytes"] as const)
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new RangeError(`Invalid ${key}`);
    for (const key of ["maxIdle", "idleTimeoutMs"] as const)
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 0) throw new RangeError(`Invalid ${key}`);
  }

  snapshot() {
    const states = [...this.slots].map(slot => slot.state);
    return { workers: this.slots.size, idle: states.filter(state => state === "idle").length,
      leased: states.filter(state => state === "leased").length,
      retiring: states.filter(state => state === "retiring").length,
      waiting: this.waiting.length, created: this.created, reused: this.reused };
  }

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<Admission> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled", error: "Code Mode cancelled before execution." });
    if (this.closed) return Promise.resolve({ status: "unavailable", error: "Code Mode worker pool is closed." });
    if (this.waiting.length >= this.options.maxWaiting)
      return Promise.resolve({ status: "unavailable", error: "Code Mode waiting queue is full. No code or tools were executed." });
    return new Promise(resolve => {
      let settled = false;
      const waiter: Waiter = {
        signal, deadline: performance.now() + timeoutMs,
        finish: result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(result);
        },
      };
      const cancel = () => waiter.finish({ status: "cancelled", error: "Code Mode cancelled while waiting. No code or tools were executed." });
      const timer = setTimeout(() => this.expire(waiter), timeoutMs);
      this.waiting.push(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      this.dispatch();
    });
  }

  private expire(waiter: Waiter) {
    waiter.finish({ status: "timed_out", error: "Code Mode worker wait exceeded its deadline. No code or tools were executed." });
  }

  private dispatch() {
    while (!this.closed && this.waiting.length) {
      const waiter = this.waiting[0];
      if (waiter.signal?.aborted) {
        waiter.finish({ status: "cancelled", error: "Code Mode cancelled before execution." });
        continue;
      }
      if (performance.now() >= waiter.deadline) { this.expire(waiter); continue; }
      let slot = [...this.slots].find(item => item.state === "idle");
      if (!slot) {
        if (this.slots.size >= this.options.maxWorkers) return;
        try { slot = this.spawn(); }
        catch {
          waiter.finish({ status: "unavailable", error: "Code Mode worker is unavailable. Use direct tools." });
          continue;
        }
      } else this.reused++;
      clearTimeout(slot.timer);
      slot.timer = undefined;
      slot.state = "leased";
      slot.uses++;
      slot.worker.ref();
      const selected = slot;
      let released = false;
      const controller = new AbortController();
      selected.cancelLease = () => controller.abort();
      const lease: CodeWorkerLease = {
        worker: slot.worker, runId: ++this.sequence, signal: controller.signal,
        release: async reuse => {
          if (released) return;
          released = true;
          selected.cancelLease = undefined;
          if (this.slots.has(selected) && selected.state === "leased" && !this.closed &&
            reuse && Number.isSafeInteger(reuse.wasmBytes) && reuse.wasmBytes > 0 && reuse.wasmBytes <= this.options.maxWasmBytes &&
            selected.uses < this.options.maxUses && (this.waiting.length > 0 || this.options.maxIdle > 0)) {
            selected.state = "idle";
            selected.idleOrder = ++this.idleSequence;
            selected.worker.unref();
            selected.timer = this.context.runInAsyncScope(() =>
              setTimeout(() => { void this.retire(selected); }, this.options.idleTimeoutMs));
            selected.timer.unref();
            this.dispatch();
            // Keep the most recently used threads. Do not discard a just-warm
            // worker while retaining an older one about to expire.
            const idle = [...this.slots].filter(slot => slot.state === "idle")
              .sort((a, b) => b.idleOrder - a.idleOrder);
            for (const extra of idle.slice(this.options.maxIdle)) void this.retire(extra);
          } else await this.retire(selected);
        },
      };
      waiter.finish({ status: "acquired", lease });
    }
  }

  private spawn(): Slot {
    const worker = this.context.runInAsyncScope(this.options.createWorker);
    let onExit!: () => void;
    const exited = new Promise<void>(resolve => { onExit = resolve; });
    const slot: Slot = { worker, state: "leased", uses: 0, idleOrder: 0, exited, onExit };
    this.slots.add(slot);
    this.created++;
    // Default worker stdio uses unreferenced pipes. Detach the default sinks
    // and drain diagnostics: stdout:true + resume() pins Node's stdio port even
    // after worker.unref(), preventing an idle host from exiting.
    worker.stdout?.unpipe();
    worker.stderr?.unpipe();
    worker.stdout?.resume();
    worker.stderr?.resume();
    const error = () => { void this.retire(slot); };
    worker.on("error", error);
    worker.once("exit", () => {
      clearTimeout(slot.timer);
      worker.off("error", error);
      this.slots.delete(slot);
      slot.onExit();
      this.dispatch();
    });
    return slot;
  }

  private retire(slot: Slot): Promise<void> {
    if (this.slots.has(slot) && slot.state !== "retiring") {
      clearTimeout(slot.timer);
      slot.timer = undefined;
      slot.state = "retiring";
      slot.worker.ref();
      // Only the exit listener frees physical capacity. A failed termination
      // must never permit an extra live worker to be created.
      void slot.worker.terminate().catch(() => undefined);
    }
    return slot.exited;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const waiter of [...this.waiting]) waiter.finish({ status: "cancelled", error: "Code Mode worker pool is shutting down." });
    for (const slot of this.slots) slot.cancelLease?.();
    this.closing = Promise.all([...this.slots].map(slot => this.retire(slot)))
      .then(() => { this.context.emitDestroy(); });
    return this.closing;
  }
}

export const codeWorkerPool = new CodeWorkerPool();
