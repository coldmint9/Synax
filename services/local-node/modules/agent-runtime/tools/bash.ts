import {
  runCommand,
  runShellCommand,
  runBackgroundShellCommand,
} from "./exec-async.js";
import * as z from "zod/v4";
import type {
  RegisteredTool,
  ToolExecutionResult,
  ToolExecutionInput,
} from "../contracts.js";
import { recordBashFileReads } from "../read-tracker.js";
import { isUnrestrictedSession, hasToolApproval } from "../sandbox/index.js";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import {
  bashPermissionSummary,
  parseBashInvocations,
  hasBackgroundBashOperator,
} from "./bash-command-policy.js";
import { resolveWorkspacePath, workspaceRoot } from "./workspace.js";
import { parseWslUncPath } from "../../workspace-location.js";
import { sessionHomeDir } from "./session-home.js";

const SAFE_REDIRECT_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
]);
const MAX_OUTPUT_BYTES = 64_000;
const EXEC_TIMEOUT_MS = 30_000;
/** Advertised bounds for the per-command timeout window. */
const MIN_EXEC_TIMEOUT_MS = 1_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;

/**
 * Resolve the timeout window for one command. The model may raise it per call
 * through the tool schema, and verification passes its own estimate; both paths
 * are clamped here so a bypassed schema cannot hand the process an unbounded or
 * sub-second window.
 */
export function resolveExecTimeoutMs(
  requested: number | undefined,
  fallback: number = EXEC_TIMEOUT_MS,
): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return fallback;
  }
  return Math.min(
    Math.max(Math.trunc(requested), MIN_EXEC_TIMEOUT_MS),
    MAX_EXEC_TIMEOUT_MS,
  );
}

/** Keep the captured bytes of one stream, with an explicit truncation notice. */
function truncateCapture(
  text: string,
  truncatedFlag: boolean,
  totalBytes: number,
  label: "STDOUT" | "STDERR",
): { text: string; truncated: boolean } {
  const truncated = truncatedFlag || text.length > MAX_OUTPUT_BYTES;
  if (!truncated) return { text, truncated: false };
  return {
    text:
      text.substring(0, MAX_OUTPUT_BYTES) +
      `\n\n[${label} TRUNCATED: ${Math.max(totalBytes, text.length)} bytes total, showing first ${MAX_OUTPUT_BYTES}.]`,
    truncated: true,
  };
}

/**
 * Detect file redirections (>, >>) to unsafe targets. Only /dev/null,
 * /dev/stdout, and /dev/stderr are allowed.
 * Returns an error message string, or null on success.
 */
function checkFileRedirects(command: string): string | null {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    // Detect > or >> at this position
    if (
      ch === ">" ||
      (ch === "2" && i + 1 < command.length && command[i + 1] === ">")
    ) {
      let redirectPos = ch === "2" ? i + 1 : i;
      let j = redirectPos;
      while (j < command.length && command[j] === ">") {
        j++;
      }
      // Skip whitespace after the redirect operator
      while (j < command.length && /\s/.test(command[j])) j++;
      // Extract the target filename
      let target = "";
      while (
        j < command.length &&
        !/\s/.test(command[j]) &&
        command[j] !== "|" &&
        command[j] !== ";" &&
        command[j] !== "&"
      ) {
        target += command[j];
        j++;
      }
      if (target && !SAFE_REDIRECT_TARGETS.has(target)) {
        return `File redirection to '${target}' is not allowed. Bash is a read-only tool. Redirect only to /dev/null, /dev/stdout, or /dev/stderr.`;
      }
      i = j - 1;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers: output analysis
// ---------------------------------------------------------------------------

/**
 * Check stderr for "command not found" style messages.
 */
function detectCommandNotFound(
  stderr: string,
  command: string,
): { notFound: boolean; commandName: string } {
  const patterns = [
    /command not found/i,
    /not found/i,
    /No such file/i,
    /not recognized/i,
  ];

  for (const pattern of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      // Try to extract the offending command name from stderr
      const cmdMatch = stderr.match(/(?:'|")([^'"]+)(?:'|")/);
      const firstInvocation = parseBashInvocations(command)[0];
      const cmdName = cmdMatch?.[1] ?? firstInvocation?.command ?? "unknown";
      return { notFound: true, commandName: cmdName };
    }
  }

  return { notFound: false, commandName: "" };
}

// ---------------------------------------------------------------------------
// Helpers: path extraction (getPattern / sandbox)
// ---------------------------------------------------------------------------

function looksLikePath(token: string): boolean {
  if (!token || token.length === 0) return false;
  // Exclude flags
  if (token.startsWith("-")) return false;
  // Exclude purely numeric tokens and obvious non-paths
  if (/^\d+$/.test(token)) return false;
  // Contains a slash → almost certainly a path
  if (token.includes("/")) return true;
  // Starts with ./ or ../
  if (token.startsWith("./") || token.startsWith("..")) return true;
  // Single dot
  if (token === ".") return true;
  // Has a common file extension
  if (/\.[a-zA-Z]{1,6}$/.test(token)) return true;
  return false;
}

/**
 * Extract path-like arguments from a command string for sandbox validation.
 */
export function extractBashPaths(command: string): string[] {
  const paths: string[] = [];

  // Quoted strings
  const quotedRegex = /(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let qMatch;
  while ((qMatch = quotedRegex.exec(command)) !== null) {
    const content = qMatch[2];
    if (looksLikePath(content)) paths.push(content);
  }

  // Unquoted tokens (blank out quoted regions first so we don't double-match)
  const withoutQuotes = command
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  const tokens = withoutQuotes.split(/\s+/);
  for (const token of tokens) {
    if (looksLikePath(token)) paths.push(token);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const bashTool: RegisteredTool = {
  id: "bash",
  label: "Bash",
  description:
    "Executes a bash command in the workspace. Permission is enforced per command and subcommand (e.g. git:diff vs git:push). File redirections are blocked except to /dev/null, /dev/stdout, and /dev/stderr unless the session is unrestricted. Prefer dedicated tools (file.read, rg, file.list) when possible.",
  category: "shell",
  internalGate: "shell",
  mutability: "read",
  resumeBehavior: "auto",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .max(4000)
      .describe("The shell command to execute; no NUL bytes. Runs in the execution host shell reported by the runtime environment."),
    workdir: z
      .string()
      .optional()
      .describe(
        "Existing directory relative to the session working directory (the default), or an absolute path permitted by the sandbox. External directories may require approval.",
      ),
    stdin: z
      .string()
      .optional()
      .describe("Optional text to pipe into the command via stdin."),
    background: z
      .boolean()
      .optional()
      .describe(
        "Run a long-lived server in the background. Returns a process ID; the user can stop it from the session sidebar.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_EXEC_TIMEOUT_MS)
      .max(MAX_EXEC_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock limit for this command in ms (${MIN_EXEC_TIMEOUT_MS}-${MAX_EXEC_TIMEOUT_MS}), default ${EXEC_TIMEOUT_MS}. Estimate it from what the command does: builds, test suites and typechecks normally need 60s-300s, quick searches and reads need the default. On timeout the output captured before the kill is returned with a [TIMED OUT] marker plus the elapsed time, so raise this and re-run instead of assuming the command failed. Ignored when background is true.`,
      ),
  }),
  progressiveDetails:
    "Accepts { command: string, workdir?: string, stdin?: string, background?: boolean, timeoutMs?: number }. Use background:true for dev servers and other long-lived services; do not detach with nohup or disown. Set timeoutMs when the command legitimately needs longer than the 30s default (tests, typechecks, installs); a timed-out command returns its partial output and can be re-run with a larger timeoutMs. Commands are classified as read-only or mutating for permission checks (e.g. rg, git:diff vs npm, git:push). Pipes and chains evaluate every segment. If a command is unavailable, fall back to dedicated tools.",
  getPattern(args) {
    if (
      typeof args === "object" &&
      args &&
      "command" in args &&
      typeof (args as { command?: unknown }).command === "string"
    ) {
      return bashPermissionSummary((args as { command: string }).command);
    }
    return undefined;
  },
  execute(input) {
    return executeBash(input);
  },
};

export function executeBash(
  input: ToolExecutionInput,
  timeoutMs?: number,
): ToolExecutionResult | Promise<ToolExecutionResult> {
  const args = input.args as {
    command?: string;
    workdir?: string;
    stdin?: string;
    background?: boolean;
    timeoutMs?: number;
  };
  if (!args?.command) throw new Error("command is required.");

  const command = args.command;
  const commandPreview =
    command.length > 80 ? command.substring(0, 77) + "..." : command;

  // 1. Null-byte guard
  if (command.includes("\0")) {
    throw new Error("Command contains null byte.");
  }

  // 2. Block file redirects unless the session is unrestricted
  if (
    !isUnrestrictedSession(input.sessionId) &&
    !hasToolApproval(input.sessionId, input.toolId)
  ) {
    const redirectError = checkFileRedirects(command);
    if (redirectError) {
      return {
        result: {
          command,
          exitCode: null,
          stdout: "",
          stderr: redirectError,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        displaySummary: `bash blocked: ${commandPreview}`,
        artifacts: [
          {
            kind: "evidence",
            title: "Bash blocked",
            summary: redirectError,
            risk: "medium",
          },
        ],
      };
    }
  }

  // 3. Resolve working directory
  const root = workspaceRoot(input.sessionId);
  const cwd = args.workdir
    ? resolveWorkspacePath(args.workdir, input.sessionId)
    : root;

  // Precedence: an explicit caller argument (verification passes its own
  // estimate), then the model's per-call value, then the default window. All of
  // them are clamped to the bounds the schema advertises.
  const execTimeoutMs = resolveExecTimeoutMs(timeoutMs ?? args.timeoutMs);

  // Execution is fully asynchronous: blocking the event loop here would
  // serialize parallel tool calls, live stream forwarding and side-channel
  // requests (profile panels, stats) for the whole lifetime of the command.
  return executeBashCommand({
    sessionId: input.sessionId,
    command,
    commandPreview,
    cwd,
    stdin: args.stdin,
    timeoutMs: execTimeoutMs,
    background: args.background === true || hasBackgroundBashOperator(command),
  });
}

interface BashExecutionInput {
  background?: boolean;
  timeoutMs: number;
  sessionId: string;
  command: string;
  commandPreview: string;
  cwd: string;
  stdin?: string;
}

async function executeBashCommand(
  input: BashExecutionInput,
): Promise<ToolExecutionResult> {
  const { command, commandPreview, cwd } = input;
  const stop = (stderr: string, title: string): ToolExecutionResult => ({
    result: {
      command,
      exitCode: null,
      stdout: "",
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    displaySummary: `${title}: ${commandPreview}`,
    artifacts: [
      { kind: "evidence", title, summary: stderr || title, risk: "medium" },
    ],
  });

  // 4. Syntax validation (bash -n on non-Windows)
  const isWindowsHostShell =
    process.platform === "win32" && !parseWslUncPath(cwd);
  if (!isWindowsHostShell) {
    const syntaxCheck = await runCommand("/bin/sh", ["-n", "-c", command], {
      cwd,
      maxBufferBytes: MAX_OUTPUT_BYTES,
      timeoutMs: 10_000,
    });
    if (syntaxCheck.timedOut) {
      return stop(
        "Syntax validation timed out.",
        "Bash syntax check timed out",
      );
    }
    if (syntaxCheck.status !== 0) {
      const stderr = (syntaxCheck.stderr || "").substring(0, MAX_OUTPUT_BYTES);
      return {
        result: {
          command,
          exitCode: null,
          stdout: "",
          stderr,
          stdoutTruncated: false,
          stderrTruncated: syntaxCheck.stderr.length > MAX_OUTPUT_BYTES,
        },
        displaySummary: `bash syntax error: ${commandPreview}`,
        artifacts: [
          {
            kind: "evidence",
            title: "Bash syntax error",
            summary: stderr || "Syntax validation failed.",
            risk: "medium",
          },
        ],
      };
    }
  }

  if (input.background) {
    const process = await runBackgroundShellCommand(input.sessionId, command, {
      cwd,
      env: {
        ...globalThis.process.env,
        HOME: await sessionHomeDir(DATA_ROOT, input.sessionId),
      },
      stdin: input.stdin,
      waitForJobs: hasBackgroundBashOperator(command),
    });
    return {
      result: { ...process, command, background: true },
      displaySummary: `Background service started: ${commandPreview}`,
      artifacts: [],
    };
  }

  // 5. Execute
  const startedAtMs = Date.now();
  const result = await runShellCommand(command, {
    cwd,
    maxBufferBytes: MAX_OUTPUT_BYTES * 2,
    timeoutMs: input.timeoutMs,
    env: { ...process.env, HOME: await sessionHomeDir(DATA_ROOT, input.sessionId) },
    stdin: input.stdin ?? undefined,
  });
  const elapsedMs = Date.now() - startedAtMs;

  // 6. Handle spawn/timeout errors. A timeout is partial evidence, not an empty
  // failure: what the command printed before the kill is exactly what tells the
  // model whether raising timeoutMs and re-running is worth it, so it is kept and
  // marked with the elapsed time instead of being discarded.
  if (result.error || result.timedOut) {
    if (result.timedOut) {
      const stdoutCapture = truncateCapture(
        result.stdout ?? "",
        result.stdoutTruncated,
        result.stdoutBytes,
        "STDOUT",
      );
      const stderrCapture = truncateCapture(
        result.stderr ?? "",
        result.stderrTruncated,
        result.stderrBytes,
        "STDERR",
      );
      const timeoutSeconds = input.timeoutMs / 1000;
      const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
      const timeoutMarker = `[TIMED OUT after ${timeoutSeconds}s (elapsed ${elapsedSeconds}s): the command was killed, so its output is partial.]`;
      const timeoutNotice = `Command timed out after ${timeoutSeconds}s (elapsed ${elapsedSeconds}s). Output captured before the kill is preserved above. Re-run with a larger timeoutMs (max ${MAX_EXEC_TIMEOUT_MS / 1000}s) if the command legitimately needs more time.`;
      return {
        result: {
          command,
          exitCode: null,
          stdout: stdoutCapture.text
            ? `${stdoutCapture.text}\n\n${timeoutMarker}`
            : timeoutMarker,
          stderr: stderrCapture.text
            ? `${stderrCapture.text}\n${timeoutNotice}`
            : timeoutNotice,
          stdoutTruncated: stdoutCapture.truncated,
          stderrTruncated: stderrCapture.truncated,
        },
        displaySummary: `bash timed out after ${timeoutSeconds}s: ${commandPreview}`,
        artifacts: [
          {
            kind: "evidence",
            title: "Bash timed out",
            summary: timeoutNotice,
            risk: "medium",
          },
        ],
      };
    }
    const errorMsg = `Spawn error: ${result.error?.message ?? "unknown error"}`;
    return {
      result: {
        command,
        exitCode: null,
        stdout: "",
        stderr: errorMsg,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      displaySummary: `bash error: ${commandPreview}`,
      artifacts: [
        {
          kind: "evidence",
          title: "Bash execution error",
          summary: errorMsg,
          risk: "medium",
        },
      ],
    };
  }

  // 7. Truncate output
  const stdoutCapture = truncateCapture(
    result.stdout ?? "",
    result.stdoutTruncated,
    result.stdoutBytes,
    "STDOUT",
  );
  const stderrCapture = truncateCapture(
    result.stderr ?? "",
    result.stderrTruncated,
    result.stderrBytes,
    "STDERR",
  );
  const stdoutTruncated = stdoutCapture.truncated;
  const stderrTruncated = stderrCapture.truncated;
  const truncatedStdout = stdoutCapture.text;
  const truncatedStderr = stderrCapture.text;

  const exitCode = result.status ?? null;
  recordBashFileReads(input.sessionId, command, exitCode);

  // 8. Command-not-found detection
  const { notFound, commandName } = detectCommandNotFound(
    result.stderr ?? "",
    command,
  );
  if (notFound) {
    const fallbackHint = `Command '${commandName}' not found. Use dedicated tools instead: rg, file.list, file.read.`;
    const finalStderr = truncatedStderr
      ? truncatedStderr + "\n" + fallbackHint
      : fallbackHint;

    return {
      result: {
        command,
        exitCode,
        stdout: truncatedStdout,
        stderr: finalStderr,
        stdoutTruncated,
        stderrTruncated: true,
      },
      displaySummary: `bash (exit ${exitCode}): ${commandPreview}`,
      artifacts: [
        {
          kind: "evidence",
          title: "Bash execution",
          summary: fallbackHint,
          risk: exitCode === 0 ? "low" : "medium",
        },
      ],
    };
  }

  // 9. Success / non-zero exit
  const summary =
    exitCode === 0
      ? `Command completed successfully.`
      : `Command exited with code ${exitCode}.`;

  return {
    result: {
      command,
      exitCode,
      stdout: truncatedStdout,
      stderr: truncatedStderr,
      stdoutTruncated,
      stderrTruncated,
    },
    displaySummary: `bash (exit ${exitCode}): ${commandPreview}`,
    artifacts: [
      {
        kind: "evidence",
        title: "Bash execution",
        summary,
        risk: exitCode === 0 ? "low" : "medium",
      },
    ],
  };
}
