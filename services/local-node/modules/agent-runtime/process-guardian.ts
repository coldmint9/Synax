import { fork, type ChildProcess } from "node:child_process";
import { runtimeAsset } from "../../infrastructure/runtime/runtime-paths.js";

interface Registration {
  resolve(): void;
  reject(error: Error): void;
  finish(): void;
  failCleanup(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProcessGroupGuard {
  ready: Promise<void>;
  closed: Promise<void>;
  release(): Promise<void>;
}

class ProcessGuardian {
  private readonly child: ChildProcess;
  private readonly groups = new Map<number, Registration>();
  private failed?: Error;

  constructor() {
    this.child = fork(runtimeAsset(
      import.meta.url,
      "../../../worker/jobs/process-guardian.cjs",
      "workers/process-guardian.cjs",
    ), [], {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.on("message", (message: unknown) => {
      const reply = message as { type?: string; pid?: number } | null;
      if (typeof reply?.pid !== "number") return;
      const group = this.groups.get(reply.pid);
      if (group && reply.type === "registered") {
        clearTimeout(group.timer);
        group.resolve();
      } else if (group && reply.type === "released") {
        clearTimeout(group.timer);
        group.resolve();
        group.finish();
        this.groups.delete(reply.pid);
        if (this.groups.size === 0) {
          this.child.unref();
          this.child.channel?.unref();
        }
      }
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("disconnect", () => this.fail(new Error("Process guardian disconnected.")));
    this.child.once("exit", () => this.fail(new Error("Process guardian exited.")));
    // An idle guardian must not keep the host alive.
    this.child.unref();
    this.child.channel?.unref();
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const [pid, group] of this.groups) {
      clearTimeout(group.timer);
      // Fail closed even if the guardian itself crashes.
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      group.reject(error);
      group.failCleanup(error);
    }
    this.groups.clear();
    this.child.unref();
    this.child.channel?.unref();
    if (guardian === this) guardian = undefined;
    if (this.child.connected) this.child.disconnect();
  }

  register(pid: number, ownerId: string): ProcessGroupGuard {
    if (this.failed) throw this.failed;
    // Stream closure may precede descendant cleanup. Keep standalone workers
    // alive until the guardian acknowledges the whole owned process tree.
    this.child.ref();
    this.child.channel?.ref();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let finish!: () => void;
    let failCleanup!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const closed = new Promise<void>((yes, no) => { finish = yes; failCleanup = no; });
    // Owners may not await teardown until after the child closes its streams.
    void closed.catch(() => {});
    const timer = setTimeout(() => this.fail(new Error("Process guardian registration timed out.")), 10_000);
    timer.unref();
    this.groups.set(pid, { resolve, reject, finish, failCleanup, timer });
    this.child.send({ type: "register", pid, ownerId }, (error) => {
      if (error) this.fail(error);
    });
    let releasing = false;
    return { ready, closed, release: () => {
      if (!releasing) { releasing = true; this.release(pid); }
      // Time out this wait without discarding ownership. A later stop can
      // retry, and the eventual acknowledgement still closes the lease.
      let timeout: ReturnType<typeof setTimeout>;
      return Promise.race([closed, new Promise<never>((_, no) => {
        timeout = setTimeout(() => no(new Error("Owned process cleanup timed out.")), 10_000);
        timeout.unref();
      })]).finally(() => clearTimeout(timeout));
    } };
  }

  release(pid: number): void {
    const group = this.groups.get(pid);
    if (!group) return;
    // Registration and release share one ordered IPC channel. If the child
    // dies before acknowledgement, release still follows its registration.
    clearTimeout(group.timer);
    group.resolve();
    if (this.child.connected) this.child.send({ type: "release", pid }, (error) => {
      if (error) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
        this.fail(error);
      }
    });
  }
}

let guardian: ProcessGuardian | undefined;

/** Bind an owned POSIX process group and its inherited ownership nonce. */
export function guardOwnedProcessGroup(pid: number, ownerId: string): ProcessGroupGuard {
  guardian ??= new ProcessGuardian();
  return guardian.register(pid, ownerId);
}

export function guardProcessGroup(child: ChildProcess, ownerId: string): ProcessGroupGuard {
  if (!child.pid) throw new Error("Command process did not start.");
  const guard = guardOwnedProcessGroup(child.pid, ownerId);
  child.once("exit", () => { void guard.release().catch(() => {}); });
  return guard;
}
