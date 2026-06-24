import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { assertSessionFileReadForWrite } from '../read-tracker.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';
import { deriveNewContentsFromChunks, parseApplyPatchEnvelope } from './patch-format.js';

function applySimplePatch(current: string, patch: string): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const body = lines.filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('@@'));
  if (body.length === 0) {
    throw new Error('patch does not contain any editable lines.');
  }

  let cursor = 0;
  const sourceLines = current.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];

  for (const line of body) {
    if (line.startsWith(' ')) {
      const expected = line.slice(1);
      while (cursor < sourceLines.length && sourceLines[cursor] !== expected) {
        output.push(sourceLines[cursor]);
        cursor += 1;
      }
      if (cursor >= sourceLines.length) {
        throw new Error(`patch context not found: ${expected}`);
      }
      output.push(sourceLines[cursor]);
      cursor += 1;
      continue;
    }
    if (line.startsWith('-')) {
      const expected = line.slice(1);
      while (cursor < sourceLines.length && sourceLines[cursor] !== expected) {
        output.push(sourceLines[cursor]);
        cursor += 1;
      }
      if (cursor >= sourceLines.length) {
        throw new Error(`patch removal target not found: ${expected}`);
      }
      cursor += 1;
      continue;
    }
    if (line.startsWith('+')) {
      output.push(line.slice(1));
      continue;
    }
  }

  while (cursor < sourceLines.length) {
    output.push(sourceLines[cursor]);
    cursor += 1;
  }
  return output.join('\n');
}

export const filePatchTool: RegisteredTool = {
  id: 'file.patch',
  label: 'Patch File',
  description:
    'Apply a bounded file edit or an opencode-style apply_patch envelope. Prefer targeted patches over full rewrites when modifying existing files.',
  category: 'write',
  internalGate: 'write',
  mutability: 'write',
  resumeBehavior: 'wait_permission',
  progressiveDetails:
    'Accepts { path: string, patch?: string, content?: string }. Supports the *** Begin Patch / *** End Patch format with Add/Update/Delete headers, and keeps a legacy single-file patch fallback for simple +/- hunks.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Workspace-relative file path to patch.'),
    patch: z.string().optional().describe('Patch content. Prefer the apply_patch envelope format.'),
    content: z.string().optional().describe('Complete replacement content when a patch is not used.'),
  }),
  getPattern(args) {
    return typeof args === 'object' && args && 'path' in args && typeof (args as { path?: unknown }).path === 'string'
      ? (args as { path: string }).path
      : undefined;
  },
  execute(input) {
    const args = input.args as { path?: string; patch?: string; content?: string };
    if (!args?.path) throw new Error('path is required.');
    if (!args.patch && typeof args.content !== 'string') {
      throw new Error('patch or content is required.');
    }
    assertSessionFileReadForWrite(input.sessionId, args.path);
    const filePath = resolveWorkspacePath(args.path, input.sessionId);
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    let next = current;
    let deleted = false;
    if (typeof args.content === 'string') {
      next = args.content;
    } else if ((args.patch ?? '').includes('*** Begin Patch')) {
      const hunks = parseApplyPatchEnvelope(args.patch ?? '');
      if (hunks.length !== 1) {
        throw new Error('file.patch accepts exactly one file operation per call.');
      }
      const hunk = hunks[0];
      const expectedPath = args.path.replace(/\\/g, '/');
      if (hunk.path.replace(/\\/g, '/') !== expectedPath) {
        throw new Error(`Patch path ${hunk.path} does not match requested path ${args.path}.`);
      }
      if (hunk.type === 'add') {
        next = hunk.contents.endsWith('\n') ? hunk.contents : `${hunk.contents}\n`;
      } else if (hunk.type === 'delete') {
        deleted = true;
      } else {
        if (hunk.movePath && path.normalize(hunk.movePath) !== path.normalize(args.path)) {
          throw new Error('file.patch does not support moving files; use a direct write to the destination path.');
        }
        next = deriveNewContentsFromChunks(args.path, hunk.chunks, current);
      }
    } else {
      next = applySimplePatch(current, args.patch ?? '');
    }
    if (deleted) {
      fs.rmSync(filePath, { force: true });
    } else {
      fs.writeFileSync(filePath, next, 'utf8');
    }
    return {
      result: {
        path: toWorkspaceRelative(filePath, input.sessionId),
        bytes: deleted ? 0 : Buffer.byteLength(next, 'utf8'),
        deleted,
      },
      displaySummary: `${deleted ? 'Deleted' : 'Patched'} ${toWorkspaceRelative(filePath, input.sessionId)}.`,
      artifacts: [
        {
          kind: 'decision',
          title: 'File patch',
          summary: `${deleted ? 'Deleted' : 'Patched'} ${toWorkspaceRelative(filePath, input.sessionId)}.`,
          risk: 'medium',
        },
      ],
    };
  },
};
