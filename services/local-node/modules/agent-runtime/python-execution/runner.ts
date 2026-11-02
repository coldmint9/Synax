import fs from "node:fs";
import path from "node:path";
import { resolvePythonRuntime } from "../../../infrastructure/runtime/python-runtime.js";
import { runCommand } from "../tools/exec-async.js";
import { MAX_STREAM_BYTES, pythonRunTimeout } from "./limits.js";
import { preparePythonSandbox } from "./sandbox.js";

export interface PythonRunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Sticky report from guard.py when the script attempted a blocked operation. */
  guardViolation: string | null;
  sandbox: string;
  /** Virtual filename, not a persisted source file. */
  script: string;
  cwd: string;
}

/** A run that never produced script output: runtime missing, spawn failure, cancellation. */
export class PythonRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonRunError";
  }
}

export interface PythonRunInput {
  sessionId: string;
  code: string;
  cwd: string;
  stdin?: string;
  /** Arguments after the virtual script filename in sys.argv. */
  args?: string[];
  /** Called by runCommand when the owned process gate opens, before compilation. */
  onStarted?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function truncate(
  text: string,
  truncatedFlag: boolean,
  totalBytes: number,
  label: "STDOUT" | "STDERR",
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  const truncated = truncatedFlag || bytes > MAX_STREAM_BYTES;
  if (!truncated) return { text, truncated: false };
  // Cut on a byte boundary, then drop a character the cut may have split so the
  // kept text stays valid UTF-8 and the advertised byte cap actually holds.
  const kept = Buffer.from(text, "utf8")
    .subarray(0, MAX_STREAM_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  const total = Math.max(totalBytes, bytes);
  return {
    text: `${kept}\n\n[${label} TRUNCATED: ${total} bytes total, showing first ${MAX_STREAM_BYTES} bytes.]`,
    truncated: true,
  };
}

function guardViolation(runDirectory: string): string | null {
  try {
    const text = fs.readFileSync(path.join(runDirectory, "denied"), "utf8").trim();
    return text ? text.slice(0, 4_000) : "The script attempted an operation the sandbox blocks.";
  } catch {
    return null;
  }
}

/**
 * Send source/config through a private stdin envelope to the fixed guard, never
 * writing model source to disk. The guard reconstructs user stdin in memory;
 * fd 0 is drained (os.read(0) returns EOF), and sys.stdin has no fileno().
 * Isolated mode keeps host Python, user site-packages,
 * PYTHON* environment variables and bytecode caches out of the run.
 */
export async function runPythonCode(input: PythonRunInput): Promise<PythonRunOutcome> {
  const python = resolvePythonRuntime();
  if (!python)
    throw new PythonRunError("python.run requires the bundled Python 3 runtime (or python3 in development).");
  input.signal?.throwIfAborted();
  const timeoutMs = pythonRunTimeout(input.timeoutMs);
  const sandbox = preparePythonSandbox({ sessionId: input.sessionId, cwd: input.cwd });
  const startedAt = Date.now();
  try {
    const result = await runCommand(python, ["-I", "-B", "-X", "utf8", sandbox.guardPath], {
      cwd: input.cwd,
      env: sandbox.env,
      inheritEnv: false,
      signal: input.signal,
      timeoutMs,
      maxBufferBytes: MAX_STREAM_BYTES * 4,
      stdin: JSON.stringify({
        version: 1,
        config: sandbox.config,
        code: input.code,
        stdin: input.stdin ?? "",
        args: input.args ?? [],
      }),
      onStarted: input.onStarted,
    });
    input.signal?.throwIfAborted();
    const violation = guardViolation(sandbox.runDirectory);
    // The working directory is validated before this point, so a spawn failure
    // here is the interpreter itself, not a missing workdir.
    if (result.error)
      throw new PythonRunError(`Python 3 could not start the script: ${result.error.message}`);
    const durationMs = Date.now() - startedAt;
    const stdout = truncate(result.stdout ?? "", result.stdoutTruncated, result.stdoutBytes, "STDOUT");
    let stderr = truncate(result.stderr ?? "", result.stderrTruncated, result.stderrBytes, "STDERR");
    if (result.timedOut) {
      const elapsed = (durationMs / 1000).toFixed(1);
      const marker = `[TIMED OUT after ${timeoutMs / 1000}s (elapsed ${elapsed}s): the process was killed, so its output is partial.]`;
      stderr = {
        truncated: stderr.truncated,
        text: stderr.text ? `${stderr.text}\n\n${marker}` : marker,
      };
    }
    if (violation)
      stderr = { truncated: stderr.truncated, text: stderr.text ? `${stderr.text}\n\n[sandbox] ${violation}` : `[sandbox] ${violation}` };
    return {
      exitCode: result.status,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: result.timedOut,
      durationMs,
      guardViolation: violation,
      sandbox: sandbox.root,
      script: sandbox.scriptPath,
      cwd: input.cwd,
    };
  } finally {
    sandbox.dispose();
  }
}
