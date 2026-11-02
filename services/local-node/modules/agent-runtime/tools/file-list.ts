import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { recordSessionFileDiscovery } from '../read-tracker.js';
import { isWorkspaceEntryVisible, toWorkspaceRelative } from './workspace.js';
import { probeReadPath, readPathMissResult } from './read-path-probe.js';

export const fileListTool: RegisteredTool = {
  id: 'file.list',
  label: 'List Files',
  description:
    'List files and folders inside the Synax workspace. Use this before reading when you need to inspect a directory.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails:
    'Accepts { path?: string, limit?: number } and returns names only. Directories are returned with their relative paths. limit is a requested maximum with an effective cap of 300; the result includes effectiveLimit, truncated, and hasMore.',
  inputSchema: z.object({
    path: z.string().min(1).optional().describe('Existing directory relative to the session working directory (default .), or an absolute path permitted by the sandbox. Lists immediate entries, not recursive descendants.'),
    limit: z.number().int().positive().optional().describe('Requested maximum immediate entries (default 100, effective cap 300).'),
  }),
  execute(input) {
    const args = (input.args ?? {}) as { path?: string; limit?: number };
    const probe = probeReadPath(args.path ?? '.', input.sessionId);
    if (probe.kind === 'missing') return readPathMissResult(probe);
    const dir = probe.absolutePath;
    const effectiveLimit = Math.min(args.limit ?? 100, 300);
    const visibleEntries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => isWorkspaceEntryVisible(entry.name, input.sessionId));
    const truncated = visibleEntries.length > effectiveLimit;
    const items = visibleEntries
      .slice(0, effectiveLimit)
      .map((entry) => ({
        name: entry.name,
        path: toWorkspaceRelative(path.join(dir, entry.name), input.sessionId),
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
    for (const item of items) {
      if (item.kind === 'file') recordSessionFileDiscovery(input.sessionId, item.path);
    }
    return {
      result: { items, effectiveLimit, truncated, hasMore: truncated },
      displaySummary: `Listed ${items.length} entries under ${toWorkspaceRelative(dir, input.sessionId)}.`,
      artifacts: [],
    };
  },
};
