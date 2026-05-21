import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

export const grepSearchTool: RegisteredTool = {
  id: 'grep.search',
  label: 'Search Text',
  description:
    'Fast workspace text search backed by ripgrep. Use this to find files containing a string before reading or editing them.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails:
    'Accepts { query: string, path?: string, limit?: number, caseSensitive?: boolean }. Searches file contents and returns file paths, line numbers, and previews.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Text to search for.'),
    path: z.string().min(1).optional().describe('Workspace-relative file or directory path to search under.'),
    limit: z.number().int().positive().max(200).optional().describe('Maximum number of matches to return.'),
    caseSensitive: z.boolean().optional().describe('Whether the search should be case-sensitive.'),
  }),
  execute(input) {
    const args = input.args as { query?: string; path?: string; limit?: number; caseSensitive?: boolean };
    if (!args?.query) throw new Error('query is required.');
    const requested = resolveWorkspacePath(args.path ?? '.');
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const hits: Array<{ path: string; line: number; preview: string }> = [];
    const stat = fs.statSync(requested);
    const cwd = stat.isDirectory() ? requested : path.dirname(requested);
    const rgArgs = ['--json', '--line-number', '--with-filename', '--color', 'never', '--fixed-strings'];
    if (!args.caseSensitive) rgArgs.push('--ignore-case');
    rgArgs.push(args.query);
    rgArgs.push(stat.isDirectory() ? '.' : path.basename(requested));
    const result = spawnSync('rg', rgArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr.trim() || `rg failed with exit code ${result.status ?? 'unknown'}.`);
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (event.type !== 'match' || !event.data?.path?.text || typeof event.data.line_number !== 'number') continue;
      const absolutePath = path.resolve(cwd, event.data.path.text);
      const fileInfo = fs.statSync(absolutePath);
      if (fileInfo.size > 256_000) continue;
      hits.push({
        path: toWorkspaceRelative(absolutePath),
        line: event.data.line_number,
        preview: (event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 240),
      });
      if (hits.length >= limit) break;
    }
    return {
      result: { query: args.query, hits },
      displaySummary: `Found ${hits.length} matches for "${args.query}".`,
      artifacts: [
        {
          kind: 'evidence',
          title: 'Search results',
          summary: `Found ${hits.length} matches for "${args.query}".`,
          risk: 'low',
        },
      ],
    };
  },
};
