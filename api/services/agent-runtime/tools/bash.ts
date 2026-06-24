import { spawnSync } from 'node:child_process';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { recordBashFileReads } from '../read-tracker.js';
import { isUnrestrictedPermissionRules } from '../permission-tiers.js';
import { agentRuntimeStore } from '../session-store.js';
import { bashPermissionSummary, parseBashInvocations } from './bash-command-policy.js';
import { resolveWorkspacePath, workspaceRoot } from './workspace.js';

const SAFE_REDIRECT_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const MAX_OUTPUT_BYTES = 64_000;
const EXEC_TIMEOUT_MS = 30_000;

function isUnrestrictedSession(sessionId: string): boolean {
  try {
    const session = agentRuntimeStore.getSession(sessionId);
    return isUnrestrictedPermissionRules(session.permissionRules);
  } catch {
    return false;
  }
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

    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;

    // Detect > or >> at this position
    if (ch === '>' || (ch === '2' && i + 1 < command.length && command[i + 1] === '>')) {
      let redirectPos = ch === '2' ? i + 1 : i;
      let j = redirectPos;
      while (j < command.length && command[j] === '>') {
        j++;
      }
      // Skip whitespace after the redirect operator
      while (j < command.length && /\s/.test(command[j])) j++;
      // Extract the target filename
      let target = '';
      while (j < command.length && !/\s/.test(command[j]) && command[j] !== '|' && command[j] !== ';' && command[j] !== '&') {
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
function detectCommandNotFound(stderr: string, command: string): { notFound: boolean; commandName: string } {
  const patterns = [/command not found/i, /not found/i, /No such file/i, /not recognized/i];

  for (const pattern of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      // Try to extract the offending command name from stderr
      const cmdMatch = stderr.match(/(?:'|")([^'"]+)(?:'|")/);
      const firstInvocation = parseBashInvocations(command)[0];
      const cmdName = cmdMatch?.[1] ?? firstInvocation?.command ?? 'unknown';
      return { notFound: true, commandName: cmdName };
    }
  }

  return { notFound: false, commandName: '' };
}

// ---------------------------------------------------------------------------
// Helpers: path extraction (getPattern / sandbox)
// ---------------------------------------------------------------------------

function looksLikePath(token: string): boolean {
  if (!token || token.length === 0) return false;
  // Exclude flags
  if (token.startsWith('-')) return false;
  // Exclude purely numeric tokens and obvious non-paths
  if (/^\d+$/.test(token)) return false;
  // Contains a slash → almost certainly a path
  if (token.includes('/')) return true;
  // Starts with ./ or ../
  if (token.startsWith('./') || token.startsWith('../')) return true;
  // Single dot
  if (token === '.') return true;
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
  const withoutQuotes = command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
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
  id: 'bash',
  label: 'Bash',
  description:
    'Executes a bash command in the workspace. Permission is enforced per command and subcommand (e.g. git:diff vs git:push). File redirections are blocked except to /dev/null, /dev/stdout, and /dev/stderr unless the session is unrestricted. Prefer dedicated tools (file.read, grep.search, file.glob, file.list) when possible.',
  category: 'shell',
  internalGate: 'shell',
  mutability: 'read',
  resumeBehavior: 'auto',
  inputSchema: z.object({
    command: z.string().min(1).max(4000).describe('The bash command to execute.'),
    workdir: z.string().optional().describe('Workspace-relative working directory. Defaults to workspace root.'),
    stdin: z.string().optional().describe('Optional text to pipe into the command via stdin.'),
  }),
  progressiveDetails:
    'Accepts { command: string, workdir?: string, stdin?: string }. Commands are classified as read-only or mutating for permission checks (e.g. rg, git:diff vs npm, git:push). Pipes and chains evaluate every segment. If a command is unavailable, fall back to dedicated tools.',
  getPattern(args) {
    if (typeof args === 'object' && args && 'command' in args && typeof (args as { command?: unknown }).command === 'string') {
      return bashPermissionSummary((args as { command: string }).command);
    }
    return undefined;
  },
  execute(input) {
    const args = input.args as { command?: string; workdir?: string; stdin?: string };
    if (!args?.command) throw new Error('command is required.');

    const command = args.command;
    const commandPreview = command.length > 80 ? command.substring(0, 77) + '...' : command;

    // 1. Null-byte guard
    if (command.includes('\0')) {
      throw new Error('Command contains null byte.');
    }

    // 2. Block file redirects unless the session is unrestricted
    if (!isUnrestrictedSession(input.sessionId)) {
      const redirectError = checkFileRedirects(command);
      if (redirectError) {
        return {
          result: { command, exitCode: null, stdout: '', stderr: redirectError, stdoutTruncated: false, stderrTruncated: false },
          displaySummary: `bash blocked: ${commandPreview}`,
          artifacts: [{ kind: 'evidence', title: 'Bash blocked', summary: redirectError, risk: 'medium' }],
        };
      }
    }

    // 3. Resolve working directory
    const root = workspaceRoot(input.sessionId);
    const cwd = args.workdir ? resolveWorkspacePath(args.workdir, input.sessionId) : root;

    // 5. Syntax validation (bash -n on non-Windows)
    const isWindows = process.platform === 'win32';
    if (!isWindows) {
      const syntaxCheck = spawnSync('bash', ['-n', '-c', command], {
        cwd,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (syntaxCheck.status !== 0) {
        const stderr = (syntaxCheck.stderr || '').substring(0, MAX_OUTPUT_BYTES);
        return {
          result: { command, exitCode: null, stdout: '', stderr, stdoutTruncated: false, stderrTruncated: syntaxCheck.stderr.length > MAX_OUTPUT_BYTES },
          displaySummary: `bash syntax error: ${commandPreview}`,
          artifacts: [{ kind: 'evidence', title: 'Bash syntax error', summary: stderr || 'Syntax validation failed.', risk: 'medium' }],
        };
      }
    }

    // 6. Execute
    const result = spawnSync(command, {
      shell: true,
      cwd,
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env: { ...process.env, HOME: cwd },
      input: args.stdin ?? undefined,
    });

    // 7. Handle spawn errors (timeout, etc.)
    if (result.error) {
      const errorMsg = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? `Command timed out after ${EXEC_TIMEOUT_MS / 1000}s.`
        : `Spawn error: ${result.error.message}`;
      return {
        result: { command, exitCode: null, stdout: '', stderr: errorMsg, stdoutTruncated: false, stderrTruncated: false },
        displaySummary: `bash error: ${commandPreview}`,
        artifacts: [{ kind: 'evidence', title: 'Bash execution error', summary: errorMsg, risk: 'medium' }],
      };
    }

    // 8. Truncate output
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const stdoutTruncated = stdout.length > MAX_OUTPUT_BYTES;
    const stderrTruncated = stderr.length > MAX_OUTPUT_BYTES;

    const truncatedStdout = stdoutTruncated
      ? stdout.substring(0, MAX_OUTPUT_BYTES) + `\n\n[STDOUT TRUNCATED: ${stdout.length} bytes total, showing first ${MAX_OUTPUT_BYTES}.]`
      : stdout;
    const truncatedStderr = stderrTruncated
      ? stderr.substring(0, MAX_OUTPUT_BYTES) + `\n\n[STDERR TRUNCATED: ${stderr.length} bytes total, showing first ${MAX_OUTPUT_BYTES}.]`
      : stderr;

    const exitCode = result.status ?? null;
    recordBashFileReads(input.sessionId, command, exitCode);

    // 9. Command-not-found detection
    const { notFound, commandName } = detectCommandNotFound(stderr, command);
    if (notFound) {
      const fallbackHint = `Command '${commandName}' not found. Use dedicated tools instead: file.glob, file.list, grep.search, file.read.`;
      const finalStderr = truncatedStderr
        ? truncatedStderr + '\n' + fallbackHint
        : fallbackHint;

      return {
        result: { command, exitCode, stdout: truncatedStdout, stderr: finalStderr, stdoutTruncated, stderrTruncated: true },
        displaySummary: `bash (exit ${exitCode}): ${commandPreview}`,
        artifacts: [{ kind: 'evidence', title: 'Bash execution', summary: fallbackHint, risk: exitCode === 0 ? 'low' : 'medium' }],
      };
    }

    // 10. Success / non-zero exit
    const summary = exitCode === 0
      ? `Command completed successfully.`
      : `Command exited with code ${exitCode}.`;

    return {
      result: { command, exitCode, stdout: truncatedStdout, stderr: truncatedStderr, stdoutTruncated, stderrTruncated },
      displaySummary: `bash (exit ${exitCode}): ${commandPreview}`,
      artifacts: [{ kind: 'evidence', title: 'Bash execution', summary, risk: exitCode === 0 ? 'low' : 'medium' }],
    };
  },
};
