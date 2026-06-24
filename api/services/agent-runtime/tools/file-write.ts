import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { assertSessionFileReadForWrite } from '../read-tracker.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

export const fileWriteTool: RegisteredTool = {
  id: 'file.write',
  label: 'Write File',
  description:
    'Write full text content to a workspace file, creating parent directories when needed. Prefer editing existing files over creating new ones.',
  category: 'write',
  internalGate: 'write',
  mutability: 'write',
  resumeBehavior: 'wait_permission',
  progressiveDetails:
    'Accepts { path: string, content: string }. Read the file first before overwriting existing content, and avoid creating docs or README files unless explicitly requested.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path to write.'),
    content: z.string().describe('Complete text content to write.'),
  }),
  getPattern(args) {
    return typeof args === 'object' && args && 'path' in args && typeof (args as { path?: unknown }).path === 'string'
      ? (args as { path: string }).path
      : undefined;
  },
  execute(input) {
    const args = input.args as { path?: string; content?: string };
    if (!args?.path) throw new Error('path is required.');
    if (typeof args.content !== 'string') throw new Error('content must be a string.');
    assertSessionFileReadForWrite(input.sessionId, args.path);
    const filePath = resolveWorkspacePath(args.path, input.sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, 'utf8');
    return {
      result: {
        path: toWorkspaceRelative(filePath, input.sessionId),
        bytes: Buffer.byteLength(args.content, 'utf8'),
      },
      displaySummary: `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${toWorkspaceRelative(filePath, input.sessionId)}.`,
      artifacts: [
        {
          kind: 'decision',
          title: 'File write',
          summary: `Updated ${toWorkspaceRelative(filePath, input.sessionId)}.`,
          risk: 'medium',
        },
      ],
    };
  },
};
