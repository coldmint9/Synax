import fs from 'node:fs';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

export const fileDeleteTool: RegisteredTool = {
  id: 'file.delete',
  label: 'Delete File',
  description:
    'Delete a single workspace file. Does not remove directories. Prefer file.patch for partial edits when the file should be kept.',
  category: 'write',
  internalGate: 'delete',
  mutability: 'write',
  resumeBehavior: 'wait_permission',
  progressiveDetails:
    'Accepts { path: string }. Confirm the file exists and is no longer needed before deleting. Use only for explicit removal requests.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path to delete.'),
  }),
  getPattern(args) {
    return typeof args === 'object' && args && 'path' in args && typeof (args as { path?: unknown }).path === 'string'
      ? (args as { path: string }).path
      : undefined;
  },
  execute(input) {
    const args = input.args as { path?: string };
    if (!args?.path) throw new Error('path is required.');

    const filePath = resolveWorkspacePath(args.path, input.sessionId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${toWorkspaceRelative(filePath, input.sessionId)}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error('file.delete only removes files, not directories.');
    }

    fs.unlinkSync(filePath);
    const relativePath = toWorkspaceRelative(filePath, input.sessionId);
    return {
      result: {
        path: relativePath,
        deleted: true,
      },
      displaySummary: `Deleted ${relativePath}.`,
      artifacts: [
        {
          kind: 'decision',
          title: 'File delete',
          summary: `Removed ${relativePath}.`,
          risk: 'high',
        },
      ],
    };
  },
};
