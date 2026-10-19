import { fork, type ChildProcess } from "node:child_process";
import { runtimeAsset } from "../../infrastructure/runtime/runtime-paths.js";

interface Registration {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
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
      if (group && (reply.type === "registered" || reply.type === "released")) {
        clearTimeout(group.timer);
        group.resolve();
        if (reply.type === "released") this.groups.delete(reply.pid);
      }
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("disconnect", () => this.fail(new Error("Process guardian disconnected.")));
    this.child.once("exit", () => this.fail(new Error("Process guardian exited.")));
    // Active commands keep the host alive. An idle guardian must not do so.
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
    }
    this.groups.clear();
    if (guardian === this) guardian = undefined;
    if (this.child.connected) this.child.disconnect();
  }

  register(pid: number): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => this.fail(new Error("Process guardian registration timed out.")), 10_000);
    timer.unref();
    this.groups.set(pid, { resolve, reject, timer });
    this.child.send({ type: "register", pid }, (error) => {
      if (error) this.fail(error);
    });
    return ready;
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

/** Attach while the command is still blocked on its start gate. */
export function guardProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.reject(new Error("Command process did not start."));
  guardian ??= new ProcessGuardian();
  const owner = guardian;
  const pid = child.pid;
  child.once("exit", () => owner.release(pid));
  return owner.register(pid);
}
