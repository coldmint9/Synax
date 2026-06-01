import fs from 'node:fs';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

const MAX_READ_BYTES = 64_000;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.sqlite', '.db', '.lock',
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function hasBinaryContent(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let nullCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) nullCount++;
  }
  return nullCount > sample.length * 0.01;
}

export const fileReadTool: RegisteredTool = {
  id: 'file.read',
  label: 'Read File',
  description:
    'Read a workspace file. Rejects binary files. Large files are truncated with a notice. Use glob or grep first when you do not know the exact path.',
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
    const filePath = resolveWorkspacePath(args.path, input.sessionId);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('path must point to a file.');

    if (isBinaryPath(filePath)) {
      throw new Error(`Refused: "${args.path}" appears to be a binary file. file.read only supports text files.`);
    }

    const buffer = fs.readFileSync(filePath);

    if (hasBinaryContent(buffer)) {
      throw new Error(`Refused: "${args.path}" contains binary content. file.read only supports text files.`);
    }

    const maxBytes = Math.min(Math.max(args.maxBytes ?? MAX_READ_BYTES, 1), MAX_READ_BYTES);
    const truncated = buffer.length > maxBytes;
    const content = buffer.subarray(0, maxBytes).toString('utf8');
    const relPath = toWorkspaceRelative(filePath, input.sessionId);

    const truncationNotice = truncated
      ? `\n\n[FILE TRUNCATED: showing ${maxBytes} of ${buffer.length} bytes. Use maxBytes or re-read with an offset to see more.]`
      : '';

    return {
      result: { path: relPath, content: content + truncationNotice, truncated, totalBytes: buffer.length },
      displaySummary: `Read ${Math.min(buffer.length, maxBytes)} of ${buffer.length} bytes from ${relPath}${truncated ? ' (truncated)' : ''}.`,
      artifacts: [
        {
          kind: 'evidence',
          title: 'File read',
          summary: `Read ${relPath}.`,
          risk: 'low',
        },
      ],
    };
  },
};
