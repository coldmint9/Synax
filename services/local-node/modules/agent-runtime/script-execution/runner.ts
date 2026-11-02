import { externalCommandEnvironment } from "../../../infrastructure/runtime/command-environment.js";
import { parseWslUncPath } from "../../workspace-location.js";
import { runCommand } from "../tools/exec-async.js";
import type { AsyncCommandResult, MemoryCommandInput, MemoryCommandResult } from "./contracts.js";

export const MEMORY_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
// Conservative budgets, including environment and space for the owned-process gate.
// POSIX stays below Linux's per-string 128 KiB limit and macOS's total ARG_MAX.
const POSIX_COMMAND_BYTES = 128 * 1024;
const WINDOWS_COMMAND_BYTES = 60 * 1024; // below CreateProcess's 32767 UTF-16 units
const LAUNCHER_RESERVE_BYTES = 16 * 1024;

function validateStrings(values: string[], label: string): void {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.includes("\0")))
    throw new Error(`${label} must contain strings without NUL bytes.`);
}

/** Validate transport size without shell escaping, temporary files or a disk fallback. */
function validateCommandSize(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const windows = process.platform === "win32";
  // Windows quoting may double backslashes/quotes; budget the worst case rather
  // than silently depending on a shell or overflowing CreateProcess.
  const strings = [command, ...args];
  const argumentBytes = strings.reduce((sum, value) => sum + (windows
    ? 2 * (2 * value.length + 3)
    : Buffer.byteLength(value) + 1 + 8), 0);
  const environmentBytes = Object.entries(env).reduce((sum, [key, value]) =>
    value === undefined ? sum : sum + (windows
      ? (key.length + value.length + 2) * 2
      : Buffer.byteLength(`${key}=${value}`) + 1 + 8), 0);
  const limit = windows ? WINDOWS_COMMAND_BYTES : POSIX_COMMAND_BYTES;
  if (argumentBytes + environmentBytes + LAUNCHER_RESERVE_BYTES > limit)
    throw new Error(`In-memory command exceeds the platform command-line byte limit (${limit} bytes including environment and launcher reserve); reduce source/arguments/environment. No temporary-file fallback is supported.`);
}

function interrupted(signal: AbortSignal | undefined, remainingMs: number): AsyncCommandResult | undefined {
  if (!signal?.aborted && remainingMs > 0) return;
  return {
    status: null, stdout: "", stderr: "", timedOut: !signal?.aborted,
    stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0,
    ...(signal?.aborted ? {
      error: Object.assign(new Error("Command cancelled."), { name: "AbortError", code: "ABORT_ERR" }),
    } : {}),
  };
}

/**
 * Only orchestration: process creation, ownership, cancellation, capture and tree
 * cleanup stay in runCommand. Source travels as an argv operand; stdin is data.
 * Cached source must be authorized by the caller on every invocation.
 */
export async function runMemoryCommand(input: MemoryCommandInput): Promise<MemoryCommandResult> {
  const sessionId = input.sessionId ?? "memory-command";
  const startedAt = performance.now();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647)
    throw new Error("timeoutMs must be a positive integer no larger than 2147483647.");
  const deadline = startedAt + input.timeoutMs;
  if (parseWslUncPath(input.cwd))
    throw new Error("run cannot execute inside a WSL workspace; use the legacy bash tool there.");
  validateStrings([input.cwd], "cwd");
  if (input.stdin !== undefined && typeof input.stdin !== "string")
    throw new Error("stdin must be a string.");
  const hasArgv = input.argv !== undefined;
  if (hasArgv && (input.language !== undefined || input.source !== undefined || input.args !== undefined))
    throw new Error("Choose argv or language/source/args, not both.");
  let command: string;
  let args: string[];
  let preflight: string[] | undefined;
  if (hasArgv) {
    validateStrings(input.argv!, "argv");
    if (!input.argv!.length || !input.argv![0]) throw new Error("argv must contain a nonempty executable.");
    [command, ...args] = input.argv!;
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command))
      throw new Error("Windows .cmd/.bat commands are unsupported in argv mode; no shell fallback is permitted. Use a native executable.");
  } else {
    if (input.language !== "sh" && input.language !== "node")
      throw new Error("Memory scripts require language sh or node; Python uses its dedicated runner.");
    validateStrings([input.source as string], "source");
    validateStrings(input.args ?? [], "args");
    if (input.language === "sh") {
      if (process.platform === "win32") throw new Error("sh scripts are not supported on Windows; use argv or node.");
      command = "/bin/sh";
      args = ["-c", input.source!, "run-sh", ...(input.args ?? [])];
      preflight = ["-n", "-c", input.source!, "run-sh", ...(input.args ?? [])];
    } else {
      command = process.execPath;
      args = ["--input-type=module", "--eval", input.source!, "--", ...(input.args ?? [])];
    }
  }
  // Snapshot caller-owned objects before any await: checked and executed source,
  // arguments and environment cannot diverge during shell syntax validation.
  const env = externalCommandEnvironment(input.env);
  validateStrings(Object.entries(env).flatMap(([key, value]) => value === undefined ? [key] : [key, value]), "env");
  validateCommandSize(command, preflight ?? args, env);
  const { signal, cwd, stdin, onStarted } = input;
  const options = { cwd, env, inheritEnv: false, signal, shell: false,
    maxBufferBytes: MEMORY_COMMAND_MAX_BUFFER_BYTES };
  let syntaxMs = 0;
  let stopped = interrupted(signal, deadline - performance.now());
  if (stopped) return { ...stopped, sessionId, durationMs: Math.round(performance.now() - startedAt) };
  if (preflight) {
    const syntaxStarted = performance.now();
    const checked = await runCommand(command, preflight, {
      ...options, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
      // No user stdin or onStarted during preflight.
    });
    syntaxMs = performance.now() - syntaxStarted;
    if (checked.error || checked.timedOut || checked.status !== 0)
      return { ...checked, sessionId, durationMs: Math.round(performance.now() - startedAt), syntaxError: !checked.error && !checked.timedOut && checked.status === 2,
        setupTimedOut: checked.timedOut };
    // Cancellation and timeout may have arrived while the successful preflight
    // was closing. Never start a second process with a fresh timeout budget.
    stopped = interrupted(signal, deadline - performance.now());
    if (stopped) return { ...stopped, sessionId, durationMs: Math.round(performance.now() - startedAt), setupTimedOut: stopped.timedOut };
  }
  const result = await runCommand(command, args, {
    ...options, stdin, onStarted,
    timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
  });
  // Node parses an eval module before executing it. Only its native compiler
  // stack identifies a parse error; `throw new SyntaxError(...)` at runtime must
  // not be mislabeled. This is diagnostic metadata, never an authorization gate.
  if (!hasArgv && input.language === "node" && !result.error && !result.timedOut && result.status !== 0)
    result.syntaxError = /^SyntaxError:[^\n]*\n\s+at compileSourceTextModule \(/m.test(result.stderr);
  if (result.timings) result.timings = {
    ...result.timings, syntaxMs: Math.round(syntaxMs), totalMs: Math.round(performance.now() - startedAt),
  };
  return { ...result, sessionId, durationMs: Math.round(performance.now() - startedAt) };
}
