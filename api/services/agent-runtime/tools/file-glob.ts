import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { isWorkspaceRelativePathBlocked, resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

// ---------------------------------------------------------------------------
// Node.js glob fallback helpers (used when ripgrep is not available)
// ---------------------------------------------------------------------------

const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.env', '.ssh']);

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
        if (BLOCKED_SEGMENTS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
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
        if (BLOCKED_SEGMENTS.has(entry.name)) continue;
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
        if (BLOCKED_SEGMENTS.has(entry.name)) continue;
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

function rgIsAvailable(): boolean {
  const check = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return check.status === 0;
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

    // -- ripgrep path --------------------------------------------------
    if (rgIsAvailable()) {
      const result = spawnSync('rg', ['--files', '--glob', pattern], {
        cwd: base,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(result.stderr.trim() || `rg failed with exit code ${result.status ?? 'unknown'}.`);
      }
      const files = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((relativePath) => path.resolve(base, relativePath))
        .map((absolutePath) => toWorkspaceRelative(absolutePath, input.sessionId))
        .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath))
        .map((relativePath) => ({
          path: relativePath,
          mtimeMs: fs.statSync(resolveWorkspacePath(relativePath, input.sessionId)).mtimeMs,
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
      .map((absolutePath) => toWorkspaceRelative(absolutePath, input.sessionId))
      .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath))
      .slice(0, limit);

    return {
      result: { pattern, files },
      displaySummary: `Matched ${files.length} files for ${pattern} (Node.js fallback).`,
      artifacts: [],
    };
  },
};
