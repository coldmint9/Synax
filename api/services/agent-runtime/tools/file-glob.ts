import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { isWorkspaceRelativePathBlocked, resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

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
    'Accepts { pattern: string, path?: string, limit?: number }. Supports patterns like "**/*.ts" or "src/**/*.tsx" and returns matching files sorted by modification time.',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Glob-like pattern, for example **/*.ts.'),
    path: z.string().min(1).optional().describe('Workspace-relative base directory.'),
    limit: z.number().int().positive().max(300).optional().describe('Maximum number of paths to return.'),
  }),
  execute(input) {
    const args = input.args as { pattern?: string; path?: string; limit?: number };
    const pattern = args?.pattern ?? '**/*';
    const base = resolveWorkspacePath(args?.path ?? '.');
    const baseStat = fs.statSync(base);
    if (!baseStat.isDirectory()) throw new Error('path must point to a directory.');
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 300);
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
      .map((absolutePath) => toWorkspaceRelative(absolutePath))
      .filter((relativePath) => !isWorkspaceRelativePathBlocked(relativePath))
      .map((relativePath) => ({
        path: relativePath,
        mtimeMs: fs.statSync(resolveWorkspacePath(relativePath)).mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.path);
    return {
      result: { pattern, files },
      displaySummary: `Matched ${files.length} files for ${pattern}.`,
      artifacts: [],
    };
  },
};
