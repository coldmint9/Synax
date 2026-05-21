import fs from 'node:fs';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

const MAX_READ_BYTES = 64_000;

export const fileReadTool: RegisteredTool = {
  id: 'file.read',
  label: 'Read File',
  description:
    'Read a workspace file with size and secret-path guards. Use glob or grep first when you do not know the exact path.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails:
    'Accepts { path: string, maxBytes?: number }. Prefer larger reads over many tiny slices when you need more context from the same file.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path to read.'),
    maxBytes: z.number().int().positive().max(MAX_READ_BYTES).optional().describe('Maximum bytes to read.'),
  }),
  getPattern(args) {
    return typeof args === 'object' && args && 'path' in args && typeof (args as { path?: unknown }).path === 'string'
      ? (args as { path: string }).path
      : undefined;
  },
  execute(input) {
    const args = input.args as { path?: string; maxBytes?: number };
    if (!args?.path) throw new Error('path is required.');
    const filePath = resolveWorkspacePath(args.path);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('path must point to a file.');
    const maxBytes = Math.min(Math.max(args.maxBytes ?? MAX_READ_BYTES, 1), MAX_READ_BYTES);
    const buffer = fs.readFileSync(filePath);
    const content = buffer.subarray(0, maxBytes).toString('utf8');
    return {
      result: { path: toWorkspaceRelative(filePath), content, truncated: buffer.length > maxBytes },
      displaySummary: `Read ${Math.min(buffer.length, maxBytes)} bytes from ${toWorkspaceRelative(filePath)}${buffer.length > maxBytes ? ' (truncated)' : ''}.`,
      artifacts: [
        {
          kind: 'evidence',
          title: 'File read',
          summary: `Read ${toWorkspaceRelative(filePath)}.`,
          risk: 'low',
        },
      ],
    };
  },
};
