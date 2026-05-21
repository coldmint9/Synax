import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { isWorkspaceEntryVisible, resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

export const fileListTool: RegisteredTool = {
  id: 'file.list',
  label: 'List Files',
  description:
    'List files and folders inside the Synapse workspace. Use this before reading when you need to inspect a directory.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails:
    'Accepts { path?: string, limit?: number } and returns names only. Directories are returned with their relative paths; blocked entries like .git and node_modules are hidden.',
  inputSchema: z.object({
    path: z.string().min(1).optional().describe('Workspace-relative directory path. Defaults to the workspace root.'),
    limit: z.number().int().positive().max(300).optional().describe('Maximum number of entries to return.'),
  }),
  execute(input) {
    const args = (input.args ?? {}) as { path?: string; limit?: number };
    const dir = resolveWorkspacePath(args.path ?? '.');
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
    const items = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => isWorkspaceEntryVisible(entry.name))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        path: toWorkspaceRelative(path.join(dir, entry.name)),
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
    return {
      result: { items },
      displaySummary: `Listed ${items.length} entries under ${toWorkspaceRelative(dir)}.`,
      artifacts: [],
    };
  },
};
