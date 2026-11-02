import type { RegisteredTool, ToolExecutionInput, ToolExecutionResult } from "../contracts.js";
import { resolveExecTimeoutMs, MAX_EXEC_TIMEOUT_MS } from "./command-timeout.js";
import { runSchema, prepareRunArgs, type RunArgs } from "../script-execution/run-schema.js";
import { rememberScript } from "../script-execution/cache.js";
import { runMemoryCommand } from "../script-execution/runner.js";
import type { MemoryCommandResult } from "../script-execution/contracts.js";
import { runPythonCode } from "../python-execution/runner.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";
import { parseWslUncPath } from "../../workspace-location.js";
import { AgentValidationError } from "../runtime-errors.js";

const MAX_OUTPUT_BYTES = 64_000;

function sourceText(source: string | string[]): string {
  return Array.isArray(source) ? source.join("\n") : source;
}
function preview(args: RunArgs): string {
  if (args.argv) return args.argv.join(" ").slice(0, 96);
  if (args.scriptId) return `script ${args.scriptId}`;
  return `${args.language ?? "script"}: ${sourceText(args.source!).split("\n").map(line => line.trim()).find(Boolean) ?? ""}`.slice(0, 96);
}
function resultFor(result: MemoryCommandResult, args: RunArgs, cwd: string, guardViolation?: string | null, details?: Record<string, unknown>): ToolExecutionResult {
  const where = toWorkspaceRelative(cwd, result.sessionId);
  const command = args.argv ?? [args.language ?? "script", ...(args.args ?? [])];
  const output = {
    mode: args.argv ? "argv" : "script",
    ...(args.language ? { language: args.language } : {}),
    ...(args.scriptId ? { scriptId: args.scriptId } : {}),
    command,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    cwd: where,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error.message } : {}),
    ...(result.syntaxError ? { syntaxError: true } : {}),
    ...(guardViolation ? { guardViolation } : {}),
    ...(details ?? {}),
  };
  const failed = Boolean(result.error || result.timedOut || result.syntaxError || result.status !== 0 || guardViolation);
  const summary = result.error
    ? `run failed in ${where}: ${result.error.message}`
    : guardViolation
      ? `run blocked in ${where}: ${guardViolation}`
    : result.syntaxError
      ? `run syntax error in ${where}: ${preview(args)}`
      : result.timedOut
        ? `run timed out in ${where}: ${preview(args)}`
        : `run (exit ${result.status ?? "none"}) in ${where}: ${preview(args)}`;
  return {
    ...(failed ? { outcome: "failed" as const } : {}),
    result: output,
    displaySummary: summary,
    artifacts: [{
      kind: "evidence",
      title: guardViolation ? "Script sandbox blocked an operation" : result.syntaxError ? "Script syntax error" : args.argv ? "Direct argv execution" : "Memory script execution",
      summary: result.error?.message ?? (result.stderr || (result.status === 0 ? `Exit 0 in ${result.durationMs} ms.` : `Exit ${result.status}.`)),
      risk: failed ? "medium" : "low",
      metadata: { mode: args.argv ? "argv" : "script", language: args.language },
    }],
  };
}

function resolveCwd(sessionId: string, workdir?: string): string {
  const cwd = resolveWorkspacePath(workdir ?? ".", sessionId);
  if (parseWslUncPath(cwd)) throw new AgentValidationError("run cannot execute inside a WSL workspace; use bash there.");
  return cwd;
}

export const runTool: RegisteredTool = {
  id: "run",
  label: "Run command or script",
  category: "shell",
  internalGate: "shell",
  // Arbitrary scripts can mutate the workspace. Registry special-cases this
  // tool for change tracking while keeping shell approval semantics.
  mutability: "read",
  resumeBehavior: "auto",
  executionTimeoutMs: MAX_EXEC_TIMEOUT_MS + 30_000,
  description: "Run one direct argv command or one in-memory sh, Python, or Node script in a single call. Prefer argv for ordinary commands and source for multi-step logic; the source is never written to a workspace or temporary script file. Scripts are conservatively treated as shell operations and require the normal shell permission gate.",
  progressiveDetails: `Accepts { argv?: string[], language?: \"sh\"|\"python\"|\"node\", source?: string|string[], scriptId?: string, args?: string[], workdir?: string, stdin?: string, timeoutMs?: number, async?: boolean }. Provide exactly one of argv/source/scriptId. argv passes executable and literal arguments without a shell. source is sent directly to the interpreter; source arrays join with newline to make multiline authoring safer. sh is POSIX /bin/sh and is syntax-checked before execution; Python and Node parse the program before running. scriptId reuses an immutable source cached in this session and still rechecks permissions. No background services; use command.manage for async completion and bash for long-lived services. Source and stdin are separate; source is never staged in a temporary file. If the host cannot pass a source within its platform argument limit, run fails instead of silently writing a file. stdout/stderr are capped at ${MAX_OUTPUT_BYTES} bytes.`,
  inputSchema: runSchema,
  getPattern(args) {
    const value = args as Partial<RunArgs> | null;
    if (value?.language) return `run:${value.language}`;
    if (value?.argv?.[0]) return `run:argv:${value.argv[0].split(/[\\/]/).pop()}`;
    if (value?.scriptId) return "run:script";
    return "run";
  },
  async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const parsed = prepareRunArgs(input.sessionId, input.args);
    const cwd = resolveCwd(input.sessionId, parsed.workdir);
    const timeoutMs = resolveExecTimeoutMs(parsed.timeoutMs);
    const script = parsed.source === undefined ? undefined : sourceText(parsed.source);
    const cached = script && parsed.language && !parsed.scriptId ? rememberScript(input.sessionId, parsed.language, script) : null;
    const executionArgs: RunArgs = cached ? { ...parsed, scriptId: cached.scriptId, source: cached.source } : parsed;
    if (parsed.language === "python") {
      const python = await runPythonCode({
        sessionId: input.sessionId,
        code: script!,
        cwd,
        stdin: parsed.stdin,
        args: parsed.args,
        timeoutMs,
        signal: input.abortSignal,
        onStarted: input.onCommandStarted,
      });
      const result: MemoryCommandResult = {
        status: python.exitCode,
        stdout: python.stdout,
        stderr: python.stderr,
        stdoutTruncated: python.stdoutTruncated,
        stderrTruncated: python.stderrTruncated,
        timedOut: python.timedOut,
        stdoutBytes: Buffer.byteLength(python.stdout),
        stderrBytes: Buffer.byteLength(python.stderr),
        sessionId: input.sessionId,
        durationMs: python.durationMs,
      };
      return resultFor(result, executionArgs, cwd, python.guardViolation, { sandbox: python.sandbox, script: python.script });
    }
    const result = await runMemoryCommand({
      sessionId: input.sessionId,
      argv: parsed.argv,
      language: parsed.language,
      source: script,
      args: parsed.args,
      cwd,
      stdin: parsed.stdin,
      timeoutMs,
      signal: input.abortSignal,
      onStarted: input.onCommandStarted,
    });
    return resultFor(result, executionArgs, cwd);
  },
};
