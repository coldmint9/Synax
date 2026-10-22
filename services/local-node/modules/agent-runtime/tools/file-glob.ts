import { searchFiles, SEARCH_TIMEOUT_MS, type SearchBudget } from "./search-files.js";
import { runCommand } from './exec-async.js';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool, ToolExecutionResult } from '../contracts.js';
import { isWorkspaceRelativePathBlocked, resolveWorkspacePath, toWorkspaceRelative, workspaceRoot } from './workspace.js';
import { resolveRipgrep } from './ripgrep.js';

export const fileGlobTool: RegisteredTool = {
  id: 'file.glob',
  label: 'Glob Files',
  description:
    'Fast file pattern matching backed by ripgrep. Use this to find files by name before reading or patching them.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails:
    'Accepts { pattern: string, path?: string, limit?: number }. Supports patterns like "**/*.ts" or "src/**/*.tsx" and returns matching files sorted by modification time. On systems without ripgrep, a Node.js fallback is used.',
  inputSchema: z.object({
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    includeIgnored: z.boolean().optional(),
    pattern: z.string().min(1).describe('Glob-like pattern, for example **/*.ts.'),
    path: z.string().min(1).optional().describe('Workspace-relative base directory.'),
    limit: z.number().int().positive().max(300).optional().describe('Maximum number of paths to return.'),
  }),
  execute(input) {
    const args = input.args as { pattern?: string; path?: string; limit?: number; timeoutMs?: number; includeIgnored?: boolean };
    const pattern = args?.pattern ?? '**/*';
    const base = resolveWorkspacePath(args?.path ?? '.', input.sessionId);
    const baseStat = fs.statSync(base);
    if (!baseStat.isDirectory()) throw new Error('path must point to a directory.');
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 300);

    // Matching runs asynchronously so the event loop (and therefore parallel
    // tool calls plus side-channel work) is never blocked by ripgrep.
    return runGlobSearch({ sessionId: input.sessionId, pattern, base, limit, includeIgnored: args.includeIgnored, budget: { deadline: Date.now() + (args.timeoutMs ?? SEARCH_TIMEOUT_MS), signal: input.abortSignal, entries: 0, files: 0, bytes: 0, status: "complete" } });
  },
};

interface GlobSearchInput {
  budget: SearchBudget;
  includeIgnored?: boolean;
  sessionId: string;
  pattern: string;
  base: string;
  limit: number;
}

async function runGlobSearch(input: GlobSearchInput): Promise<ToolExecutionResult> {
  const { sessionId, pattern, base, limit, budget } = input;

  // -- ripgrep path (absolute path; the desktop GUI PATH is minimal) --
  const rgPath = await resolveRipgrep();
  if (rgPath) {
    let count = 0;
    const result = await runCommand(rgPath, ['--files', '--glob', pattern, ...(input.includeIgnored ? ['--hidden', '--no-ignore'] : [])], {
      cwd: base, signal: budget.signal, timeoutMs: Math.max(1, budget.deadline - Date.now()), stopOnOutputLimit: true,
      onStdout(chunk) { count += chunk.split('\n').length - 1; return count < limit; },
    });
    if (budget.signal?.aborted) budget.status = 'cancelled';
    else if (result.timedOut) budget.status = 'timeout';
    else if (result.stoppedEarly || result.stdoutTruncated) budget.status = 'limit_reached';
    if (result.error && budget.status === 'complete') throw result.error;
    if (budget.status === 'complete' && result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr.trim() || `rg failed with exit code ${result.status ?? 'unknown'}.`);
    }
    const files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((relativePath) => path.resolve(base, relativePath))
      .map((absolutePath) => toWorkspaceRelative(absolutePath, sessionId))
      .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath, sessionId))
      .map((relativePath) => ({
        path: relativePath,
        mtimeMs: (() => { try { return fs.statSync(resolveWorkspacePath(relativePath, sessionId)).mtimeMs; } catch { return 0; } })(),
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.path);
    return {
      result: { pattern, files, status: budget.status, partial: budget.status !== "complete" },
      displaySummary: `Matched ${files.length} files for ${pattern}.${budget.status !== "complete" ? ` Partial search: ${budget.status}.` : ""}`,
      artifacts: [],
    };
  }

  // -- Node.js fallback ----------------------------------------------
  const absoluteFiles: string[] = [];
  for await (const file of searchFiles(base, workspaceRoot(sessionId), budget, { filePattern: pattern, includeIgnored: input.includeIgnored })) {
    absoluteFiles.push(file);
    if (absoluteFiles.length >= limit) { budget.status = "limit_reached"; break; }
  }
  const files = absoluteFiles
    .map((absolutePath) => toWorkspaceRelative(absolutePath, sessionId))
    .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath, sessionId))
    .slice(0, limit);

  return {
    result: { pattern, files, status: budget.status, partial: budget.status !== "complete" },
    displaySummary: `Matched ${files.length} files for ${pattern} (Node.js fallback).${budget.status !== "complete" ? ` Partial search: ${budget.status}.` : ""}`,
    artifacts: [],
  };
}
