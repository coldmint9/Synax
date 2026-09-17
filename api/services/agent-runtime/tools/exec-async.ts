import { spawnOwnedProcess } from "../owned-process.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

/**
 * Async process execution helpers for agent tools.
 *
 * Why this exists: agent tools must never run child processes with the
 * synchronous `spawnSync`/`execFileSync` APIs. Those calls block the Node
 * event loop for the whole lifetime of the child process (a `npx tsc` run is
 * tens of seconds), which serializes everything that should be concurrent:
 * parallel tool calls in the same step, live stream forwarding to the parent
 * process, side-channel requests (profile/workspace panels, stats) and the
 * asynchronous session-title generation.
 */

export interface AsyncCommandOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard wall-clock limit; the process group is killed when exceeded. */
  timeoutMs?: number;
  /** Bytes kept for stdout/stderr before the rest is dropped. */
  maxBufferBytes?: number;
  /** Text piped into the child's stdin. */
  stdin?: string;
  /** Run through the shell (`sh -c` / `cmd /c`). */
  shell?: boolean;
}

export interface AsyncCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES, ...). */
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Total bytes produced before truncation, for user-facing notices. */
  stdoutBytes: number;
  stderrBytes: number;
}

const commandSignal = new AsyncLocalStorage<AbortSignal | undefined>();
const ownedCommands = new Map<
  (signal: NodeJS.Signals) => void,
  Promise<void>
>();
export function withCommandSignal<T>(
  signal: AbortSignal | undefined,
  action: () => T,
): T {
  return commandSignal.run(signal, action);
}
/** Worker shutdown must kill command groups before exiting the worker itself. */
export async function terminateOwnedCommands(): Promise<void> {
  const commands = [...ownedCommands];
  for (const [kill] of commands) kill("SIGKILL");
  await Promise.all(commands.map(([, closed]) => closed));
}
const abortError = (): NodeJS.ErrnoException =>
  Object.assign(new Error("Command cancelled."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const KILL_GRACE_MS = 2000;

interface CaptureBuffer {
  chunks: Buffer[];
  size: number;
  total: number;
  truncated: boolean;
}

function createCapture(maxBytes: number): CaptureBuffer {
  return { chunks: [], size: 0, total: 0, truncated: false };
}

function captureChunk(
  buffer: CaptureBuffer,
  chunk: Buffer,
  maxBytes: number,
): void {
  buffer.total += chunk.length;
  if (buffer.size >= maxBytes) {
    buffer.truncated = true;
    return;
  }
  const remaining = maxBytes - buffer.size;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  buffer.chunks.push(slice);
  buffer.size += slice.length;
  if (slice.length < chunk.length) buffer.truncated = true;
}

function captureText(buffer: CaptureBuffer): string {
  return Buffer.concat(buffer.chunks, buffer.size).toString("utf8");
}

/**
 * Run a child process without blocking the event loop.
 *
 * On POSIX the child is started in its own process group so a timeout can
 * terminate the whole tree (shell + grandchildren) instead of leaking them.
 */
export function runCommand(
  command: string,
  args: string[],
  options: AsyncCommandOptions = {},
): Promise<AsyncCommandResult> {
  const signal = options.signal ?? commandSignal.getStore();
  if (signal?.aborted)
    return Promise.resolve({
      status: null,
      stdout: "",
      stderr: "",
      error: abortError(),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  const useProcessGroup = process.platform !== "win32";

  return new Promise<AsyncCommandResult>((resolve) => {
    const stdout = createCapture(maxBufferBytes);
    const stderr = createCapture(maxBufferBytes);
    let timedOut = false;
    let settled = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawnOwnedProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
    });

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (useProcessGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let markClosed!: () => void;
    const closed = new Promise<void>((resolveClosed) => {
      markClosed = resolveClosed;
    });
    ownedCommands.set(killTree, closed);
    const onAbort = () => {
      aborted = true;
      killTree("SIGKILL");
    };
    const cleanup = () => {
      ownedCommands.delete(killTree);
      signal?.removeEventListener("abort", onAbort);
      markClosed();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeout = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }, options.timeoutMs);
      timeout.unref?.();
      child.once("close", () => clearTimeout(timeout));
    }

    child.stdout?.on("data", (chunk: Buffer) =>
      captureChunk(stdout, chunk, maxBufferBytes),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      captureChunk(stderr, chunk, maxBufferBytes),
    );

    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* the command may not read stdin */
      });
      child.stdin?.end(options.stdin);
    }

    let spawnError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      if (child.pid === undefined) cleanup();
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: null,
        stdout: captureText(stdout),
        stderr: captureText(stderr),
        error: aborted ? abortError() : spawnError,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
      });
    });

    child.on("close", (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: code ?? (signal ? null : 0),
        stdout: captureText(stdout),
        stderr: captureText(stderr),
        error: aborted ? abortError() : spawnError,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
      });
    });
  });
}

/** Convenience wrapper for shell commands (`sh -c` on POSIX, `cmd /c` on Windows). */
export function runShellCommand(
  command: string,
  options: AsyncCommandOptions = {},
): Promise<AsyncCommandResult> {
  return runCommand(command, [], { ...options, shell: true });
}

/** Start a tracked service; its worker stays alive until the last service exits. */
export async function runBackgroundShellCommand(
  sessionId: string,
  command: string,
  options: AsyncCommandOptions & { waitForJobs?: boolean } = {},
): Promise<{ processId: string; pid: number }> {
  const signal = options.signal ?? commandSignal.getStore();
  if (signal?.aborted) throw abortError();
  const child = spawnOwnedProcess(
    options.waitForJobs && process.platform !== "win32"
      ? `${command}\nwait`
      : command,
    [],
    {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      background: true,
      commandLabel: command,
      sessionId,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
    },
  );
  const kill = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      ownedCommands.delete(kill);
      resolve();
    }),
  );
  ownedCommands.set(kill, closed);
  // Drain both pipes without retaining an unbounded server log in memory.
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.stdin);
  child.on("message", (message: any) => {
    if (message?.type === "finished") kill("SIGKILL");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Background service did not start.")),
        10_000,
      );
      child.on("message", (message: any) => {
        if (message?.type === "started") resolve();
      });
      child.once("error", reject);
      child.once("close", () =>
        reject(
          new Error(stderr || "Background service exited before startup."),
        ),
      );
      if (signal?.aborted) {
        abort();
        reject(abortError());
      }
    });
    return { processId: child.ownedProcessId, pid: child.pid! };
  } catch (error) {
    kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
