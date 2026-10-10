import { fork, type ChildProcess } from "node:child_process";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import { runtimeAsset } from "../../infrastructure/runtime/runtime-paths.js";
import type { RuntimeExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { assertBatchInput } from "./checkpoints/version-runtime/batch-input.js";
import { projectReplayChunk } from "./runtime-stream-projection.js";
import type { AgentRunStreamChunk } from "./contracts.js";
import { runtimeJournal } from "./runtime-journal.js";

export interface JournalWrite {
  id: number;
  sessionId: string;
  runId: string;
  revision: number;
  chunks: AgentRunStreamChunk[];
  context?: RuntimeExecutionContext;
}

/** One writer per host, with bounded admission and commit acknowledgements. */
export class JournalWriter {
  private child?: ChildProcess;
  private sequence = 0;
  private bytes = 0;
  private closed = false;
  private idleWaiters = new Set<() => void>();
  private retiring = new Set<Promise<void>>();
  private pending = new Map<number, {
    bytes: number;
    sessionId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  async append(sessionId: string, runId: string, chunks: AgentRunStreamChunk[], revision: number, context?: RuntimeExecutionContext): Promise<void> {
    if (this.closed) throw new Error("Journal writer is closed.");
    if (!chunks.length) return;
    if (chunks.length > 256) throw new Error("Replay burst limit exceeded.");
    chunks = chunks.map(projectReplayChunk);
    const bytes = assertBatchInput(chunks);
    if (this.pending.size >= 64 || this.bytes + bytes > 4 * 1024 * 1024)
      throw new Error("Journal writer is busy; bounded queue is full.");
    const child = this.ensureChild();
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, new Error("Journal commit acknowledgement timed out.")), 30_000);
      this.pending.set(id, { bytes, sessionId, resolve, reject, timer });
      this.bytes += bytes;
      child.channel?.ref();
      child.send({ id, sessionId, runId, chunks, revision, context } satisfies JournalWrite, error => {
        if (error) this.fail(child, error);
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    if (this.retiring.size) throw new Error("Previous journal writer has not exited.");
    const runner = runtimeAsset(import.meta.url, "../../../worker/jobs/journal-writer.ts", "workers/journal-writer.cjs");
    const child = fork(runner, [], {
      env: { ...process.env, DATA_ROOT, SYNAX_AGENT_SESSION_CHILD: "1", ELECTRON_RUN_AS_NODE: "1" },
      execArgv: runner.endsWith(".ts") ? ["--import", "tsx/esm"] : [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    } as Parameters<typeof fork>[2]);
    this.child = child;
    child.unref();
    child.on("message", (message: { id: number; error?: string }) => {
      if (this.child !== child) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      this.bytes -= request.bytes;
      if (message.error) request.reject(new Error(message.error));
      else {
        runtimeJournal.notifyCommitted(request.sessionId);
        request.resolve();
      }
      if (!this.pending.size) {
        child.channel?.unref();
        this.notifyIdle();
      }
    });
    child.on("error", error => this.fail(child, error));
    child.on("exit", () => this.fail(child, new Error("Journal writer exited before acknowledgement.")));
    return child;
  }

  private fail(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.bytes = 0;
    this.notifyIdle();
    // Never replay an unacknowledged transaction: it may already have committed.
    child.ref();
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const retiring = exited.finally(() => {
      clearTimeout(deadline);
      this.retiring.delete(retiring);
    });
    this.retiring.add(retiring);
    child.kill();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pending.size) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
    await Promise.all(this.retiring);
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.ref();
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.disconnect();
    });
  }

  private notifyIdle(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export const journalWriter = new JournalWriter();
