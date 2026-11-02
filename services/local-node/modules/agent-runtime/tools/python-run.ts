import fs from "node:fs";
import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionResult } from "../contracts.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CODE_CHARS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_STREAM_BYTES,
  MIN_EXEC_TIMEOUT_MS,
} from "../python-execution/limits.js";
import { PythonRunError, runPythonCode } from "../python-execution/runner.js";
import { SandboxViolationError } from "../sandbox/index.js";
import { parseWslUncPath } from "../../workspace-location.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";

function preview(code: string): string {
  const line = code.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function failureResult(message: string): ToolExecutionResult {
  return {
    outcome: "failed",
    result: { error: message },
    displaySummary: `python.run failed: ${message}`,
    artifacts: [{ kind: "evidence", title: "Python execution error", summary: message, risk: "medium" }],
  };
}

/** Fail with the directory the model asked for, not a bare spawn ENOENT. */
function resolveWorkdir(sessionId: string, workdir?: string): string {
  const target = resolveWorkspacePath(workdir ?? ".", sessionId);
  // The bundled interpreter is a host binary; a Linux workspace is only reachable
  // through bash, which owns the WSL bridge.
  if (parseWslUncPath(target))
    throw new PythonRunError("python.run cannot execute inside a WSL workspace; use bash there.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new PythonRunError(`workdir does not exist: ${workdir ?? target}`);
  }
  if (!stat.isDirectory()) throw new PythonRunError(`workdir is not a directory: ${workdir ?? target}`);
  return target;
}

export const pythonRunTool: RegisteredTool = {
  id: "python.run",
  label: "Run Python",
  category: "shell",
  internalGate: "shell",
  mutability: "read",
  resumeBehavior: "auto",
  executionTimeoutMs: MAX_EXEC_TIMEOUT_MS + 30_000,
  description:
    "Run Python 3 code from memory and return its stdout, stderr and exit code. Source and configuration are sent to a fixed guard through a private stdin envelope, never written to disk. Execution uses isolated mode (-I -B), so user site-packages, PYTHON* variables, host credentials and bytecode caches never apply. Prefer it over bash for data analysis, CSV/JSON/XML parsing, numeric work, text transformation, code refactoring and multi-step scripting; use file.read, file.write, file.patch or file.generate for ordinary file edits. Reads and writes stay inside the workspace and sandbox, and network access, child processes, ctypes and links are blocked unless the session is unrestricted. Like bash, it needs shell approval.",
  progressiveDetails:
    `Accepts { code, args?, workdir?, stdin?, timeoutMs? }. args follows the virtual script filename in sys.argv. stdin is reconstructed as an in-memory UTF-8 text stream supporting input(), sys.stdin.read() and sys.stdin.buffer; it has no fileno(), and raw os.read(0, ...) returns EOF, not user input. __file__, argv[0] and result.script name a virtual main.py that does not exist on disk. workdir resolves against the workspace, must be an existing directory and defaults to the workspace root, which is also the process cwd. timeoutMs defaults to ${DEFAULT_TIMEOUT_MS} and is clamped to ${MIN_EXEC_TIMEOUT_MS}–${MAX_EXEC_TIMEOUT_MS}; a timeout kills the process tree and keeps partial output. stdout and stderr are each capped at ${MAX_STREAM_BYTES} bytes with a truncation notice. The sandbox persists across calls (HOME, TMPDIR and SYNAX_SANDBOX point at it) while each call reserves a fresh run-* directory for violation reports that is removed afterwards; the working directory and the sandbox are appended to sys.path after the standard library, so persisted helper modules can still be imported. A delegated writeScope narrows which workspace paths a script may write. A blocked operation raises PermissionError and is reported even if the script catches it. Print results; stdout is the only text returned, so write files with the dedicated file tools when the change must be reviewable.`,
  inputSchema: z.object({
    code: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .refine((value) => Boolean(value.trim()), "code must not be blank")
      .describe("Python 3 source executed as __main__. Keep it self-contained; imports of stdlib modules and modules in workdir or the sandbox are available."),
    workdir: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Existing directory relative to the workspace, or an absolute path permitted by the sandbox. Defaults to the workspace root."),
    stdin: z.string().max(1_000_000).optional().describe("Text piped into the script's stdin, at most 1 MB."),
    args: z.array(z.string()).optional().describe("Arguments after the virtual script filename in sys.argv; no shell parsing."),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_EXEC_TIMEOUT_MS)
      .max(MAX_EXEC_TIMEOUT_MS)
      .optional()
      .describe(`Wall-clock limit in ms (${MIN_EXEC_TIMEOUT_MS}–${MAX_EXEC_TIMEOUT_MS}), default ${DEFAULT_TIMEOUT_MS}. On timeout partial output is returned with a TIMED OUT marker; narrow the work before retrying.`),
  }),
  getPattern: () => "python.run",
  async execute(input) {
    const args = pythonRunTool.inputSchema!.parse(input.args) as {
      code: string;
      workdir?: string;
      stdin?: string;
      args?: string[];
      timeoutMs?: number;
    };
    try {
      const cwd = resolveWorkdir(input.sessionId, args.workdir);
      const outcome = await runPythonCode({
        sessionId: input.sessionId,
        code: args.code,
        cwd,
        stdin: args.stdin,
        args: args.args,
        timeoutMs: args.timeoutMs,
        signal: input.abortSignal,
        onStarted: input.onCommandStarted,
      });
      const where = toWorkspaceRelative(cwd, input.sessionId);
      const result = {
        ...outcome,
        cwd: where,
        preview: preview(args.code),
      };
      if (outcome.guardViolation)
        return {
          outcome: "failed",
          result,
          displaySummary: `python.run blocked: ${outcome.guardViolation}`,
          artifacts: [{ kind: "evidence", title: "Python sandbox blocked an operation", summary: outcome.guardViolation, risk: "high" }],
        };
      const summary = outcome.timedOut
        ? `python.run timed out after ${(outcome.durationMs / 1000).toFixed(1)}s in ${where}: ${preview(args.code)}`
        : `python.run (exit ${outcome.exitCode ?? "none"}) in ${where}: ${preview(args.code)}`;
      return {
        result,
        displaySummary: summary,
        artifacts: [{
          kind: "evidence",
          title: outcome.timedOut ? "Python timed out" : "Python execution",
          summary: outcome.timedOut
            ? `Timed out after ${outcome.durationMs} ms; partial output was preserved.`
            : `Exit ${outcome.exitCode} in ${outcome.durationMs} ms.`,
          risk: outcome.exitCode === 0 && !outcome.timedOut ? "low" : "medium",
        }],
      };
    } catch (error) {
      if (error instanceof PythonRunError) return failureResult(error.message);
      if (error instanceof SandboxViolationError) return failureResult(error.message);
      throw error;
    }
  },
};
