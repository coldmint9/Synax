import { runCommand } from './exec-async.js';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool, ToolExecutionResult } from '../contracts.js';
import { isWorkspaceRelativePathBlocked, resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

// ---------------------------------------------------------------------------
// Node.js glob fallback helpers (used when ripgrep is not available)
// ---------------------------------------------------------------------------

function segMatch(name: string, segment: string): boolean {
  const regex = new RegExp(
    '^' +
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]') +
      '$',
  );
  return regex.test(name);
}

function globWalk(baseDir: string, pattern: string, limit: number): string[] {
  const segments = pattern.split('/').filter((s) => s !== '');
  const hits: Array<{ filePath: string; mtimeMs: number }> = [];

  function walk(currentDir: string, segIdx: number): void {
    if (hits.length >= limit) return;

    if (segIdx >= segments.length) {
      try {
        const st = fs.statSync(currentDir);
        if (st.isFile()) hits.push({ filePath: currentDir, mtimeMs: st.mtimeMs });
      } catch {
        /* skip unreadable */
      }
      return;
    }

    const seg = segments[segIdx];
    const isLast = segIdx === segments.length - 1;

    if (seg === '**') {
      // Match zero directories: skip ** and try next segment at this level
      walk(currentDir, segIdx + 1);

      // Match one or more directories: recurse into subdirectories
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= limit) return;
        if (!entry.isDirectory()) continue;
        walk(path.join(currentDir, entry.name), segIdx); // keep ** active
      }
      return;
    }

    // Regular segment -- read directory and match names
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    if (isLast) {
      // Matching files
      for (const entry of entries) {
        if (hits.length >= limit) return;
        if (!entry.isFile()) continue;
        if (!segMatch(entry.name, seg)) continue;
        try {
          const full = path.join(currentDir, entry.name);
          const st = fs.statSync(full);
          hits.push({ filePath: full, mtimeMs: st.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    } else {
      // Matching directories
      for (const entry of entries) {
        if (hits.length >= limit) return;
        if (!entry.isDirectory()) continue;
        if (!segMatch(entry.name, seg)) continue;
        walk(path.join(currentDir, entry.name), segIdx + 1);
      }
    }
  }

  walk(baseDir, 0);

  return hits
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((e) => e.filePath);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

let rgAvailability: Promise<boolean> | null = null;

/**
 * Ripgrep availability probe. Cached and asynchronous: the previous
 * synchronous probe spawned `rg --version` on every single glob call.
 */
function rgIsAvailable(): Promise<boolean> {
  if (!rgAvailability) {
    rgAvailability = runCommand('rg', ['--version'], { timeoutMs: 3000 })
      .then((check) => check.status === 0)
      .catch(() => false);
  }
  return rgAvailability;
}

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
    pattern: z.string().min(1).describe('Glob-like pattern, for example **/*.ts.'),
    path: z.string().min(1).optional().describe('Workspace-relative base directory.'),
    limit: z.number().int().positive().max(300).optional().describe('Maximum number of paths to return.'),
  }),
  execute(input) {
    const args = input.args as { pattern?: string; path?: string; limit?: number };
    const pattern = args?.pattern ?? '**/*';
    const base = resolveWorkspacePath(args?.path ?? '.', input.sessionId);
    const baseStat = fs.statSync(base);
    if (!baseStat.isDirectory()) throw new Error('path must point to a directory.');
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 300);

    // Matching runs asynchronously so the event loop (and therefore parallel
    // tool calls plus side-channel work) is never blocked by ripgrep.
    return runGlobSearch({ sessionId: input.sessionId, pattern, base, limit });
  },
};

interface GlobSearchInput {
  sessionId: string;
  pattern: string;
  base: string;
  limit: number;
}

async function runGlobSearch(input: GlobSearchInput): Promise<ToolExecutionResult> {
  const { sessionId, pattern, base, limit } = input;

  // -- ripgrep path --------------------------------------------------
  if (await rgIsAvailable()) {
    const result = await runCommand('rg', ['--files', '--glob', pattern], { cwd: base });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
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
        mtimeMs: fs.statSync(resolveWorkspacePath(relativePath, sessionId)).mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.path);
    return {
      result: { pattern, files },
      displaySummary: `Matched ${files.length} files for ${pattern}.`,
      artifacts: [],
    };
  }

  // -- Node.js fallback ----------------------------------------------
  const absoluteFiles = globWalk(base, pattern, limit);
  const files = absoluteFiles
    .map((absolutePath) => toWorkspaceRelative(absolutePath, sessionId))
    .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath, sessionId))
    .slice(0, limit);

  return {
    result: { pattern, files },
    displaySummary: `Matched ${files.length} files for ${pattern} (Node.js fallback).`,
    artifacts: [],
  };
}
