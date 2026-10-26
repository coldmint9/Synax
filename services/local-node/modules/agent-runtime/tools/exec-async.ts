import { spawnOwnedProcess } from "../owned-process.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { parseWslUncPath } from "../../workspace-location.js";
import { stopWslOwnedProcess } from "../../../infrastructure/wsl/wsl.js";
import { logger } from "../../../infrastructure/runtime/logger.js";

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
  /** Return false to stop a bounded streaming consumer once it has enough data. */
  onStdout?: (chunk: string) => boolean | void;
  stopOnOutputLimit?: boolean;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Use an explicit environment without inheriting API/provider credentials. */
  inheritEnv?: boolean;
  /** Hard wall-clock limit; the process group is killed when exceeded. */
  timeoutMs?: number;
  /** Bytes kept for stdout/stderr before the rest is dropped. */
  maxBufferBytes?: number;
  /** Text piped into the child's stdin. */
  stdin?: string;
  /** Run through the shell (`sh -c` / `cmd /c`). */
  shell?: boolean;
  /** Wait for descendant cleanup before returning (e.g. workspace handoff). */
  waitForCleanup?: boolean;
}

export interface AsyncCommandResult {
  stoppedEarly?: boolean;
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
    let stoppedEarly = false;
    let stopping = false;
    const decoder = new TextDecoder();
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawnOwnedProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      inheritEnv: options.inheritEnv,
      shell: options.shell ?? false,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
    });

    const wsl = options.cwd ? parseWslUncPath(options.cwd) : null;
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (wsl) {
        void stopWslOwnedProcess(
          wsl.distribution,
          child.ownedProcessId,
        ).finally(() => {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        });
        return;
      }
      try {
        if (useProcessGroup) process.kill(-child.pid, signal);
        else {
          // Killing cmd.exe alone leaves its children holding stdout open.
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => { try { child.kill(signal); } catch { /* already gone */ } });
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const stopOwned = (signal: NodeJS.Signals) => {
      stopping = true;
      killTree(signal);
    };
    const onAbort = () => {
      aborted = true;
      stopOwned("SIGKILL");
    };
    const cleanup = () => {
      ownedCommands.delete(stopOwned);
      signal?.removeEventListener("abort", onAbort);
    };
    // Result delivery does not release ownership. Even after close, shutdown
    // must wait for the guardian's eventual acknowledgement, not its timeout.
    const reaped = child.ownedProcessReaped.then(cleanup);
    ownedCommands.set(stopOwned, reaped);
    void reaped.catch(error => {
      signal?.removeEventListener("abort", onAbort);
      // Retain the rejected entry so shutdown reports unconfirmed cleanup.
      logger.error({ err: error, ownedProcessId: child.ownedProcessId }, "Command process cleanup failed");
    });
    void child.ownedProcessClosed.catch(error => {
      logger.warn({ err: error, ownedProcessId: child.ownedProcessId }, "Command cleanup wait failed; ownership retained until acknowledgement");
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeout = setTimeout(() => {
        timedOut = true;
        stopOwned("SIGTERM");
        killTimer = setTimeout(() => stopOwned("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }, options.timeoutMs);
      timeout.unref?.();
      child.once("close", () => clearTimeout(timeout));
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      captureChunk(stdout, chunk, maxBufferBytes);
      if (!stoppedEarly && (options.onStdout?.(decoder.decode(chunk, { stream: true })) === false ||
          options.stopOnOutputLimit && stdout.truncated)) {
        stoppedEarly = true;
        stopOwned("SIGKILL");
      }
    });
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
      // A spawned process still owns its slot until its stdio/tree has closed.
      if (child.pid !== undefined) return;
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

    child.on("close", async (code, exitSignal) => {
      if (timedOut || aborted || stoppedEarly) killTree("SIGKILL");
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (options.waitForCleanup || timedOut || aborted || stoppedEarly || stopping || exitSignal || spawnError) {
        try {
          await child.ownedProcessClosed;
        } catch (error) {
          spawnError ??= Object.assign(new Error("Command process cleanup could not be confirmed.", { cause: error }), {
            code: "PROCESS_CLEANUP_FAILED",
          });
        }
      }
      resolve({
        status: code ?? (exitSignal ? null : 0),
        stdout: captureText(stdout),
        stderr: captureText(stderr),
        error: aborted ? abortError() : spawnError,
        timedOut,
        stoppedEarly,
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

/** Background services are hosted by the API PTY manager, not this model worker. */
export async function runBackgroundShellCommand(
  sessionId: string,
  command: string,
  options: AsyncCommandOptions & { waitForJobs?: boolean } = {},
): Promise<{ processId: string; pid: number }> {
  const { startBackgroundTerminal } =
    await import("../../../infrastructure/terminals/terminal-service.js");
  return startBackgroundTerminal(sessionId, command, {
    ...options,
    signal: options.signal ?? commandSignal.getStore(),
  });
}
