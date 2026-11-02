import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from '../contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './workspace.js';

export interface ReadPathMiss {
  kind: 'missing';
  path: string;
  reason: 'ENOENT' | 'ENOTDIR';
  nearestDirectory: string;
  suggestions?: string[];
}

type ReadPathProbe = { kind: 'found'; absolutePath: string; stat: fs.Stats } | ReadPathMiss;

function missingPathCode(error: unknown): ReadPathMiss['reason'] | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? code : undefined;
}

/** Only the requested read target is a probe, never a subprocess or write error. */
export function probeReadPath(inputPath: string, sessionId: string): ReadPathProbe {
  // Sandbox resolution is deliberately outside the catch: denial is not a miss.
  const absolutePath = resolveWorkspacePath(inputPath, sessionId);
  try {
    return { kind: 'found', absolutePath, stat: fs.statSync(absolutePath) };
  } catch (error) {
    const reason = missingPathCode(error);
    if (!reason) throw error;

    const root = resolveWorkspacePath('.', sessionId);
    const relative = path.relative(root, absolutePath);
    // Stay conservative for external/reference paths: their root may be offline.
    // Losing the execution root itself is also an infrastructure failure.
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error;
    if (!fs.statSync(root).isDirectory()) throw error;

    // Walk only ancestors within the verified root. Do not scan or search a
    // broader tree automatically, and never substitute a guessed target.
    let parent = path.dirname(absolutePath);
    while (parent !== root) {
      try {
        if (fs.statSync(parent).isDirectory()) break;
      } catch (parentError) {
        if (!missingPathCode(parentError)) throw parentError;
      }
      parent = path.dirname(parent);
    }
    return {
      kind: 'missing',
      path: toWorkspaceRelative(absolutePath, sessionId),
      reason,
      nearestDirectory: toWorkspaceRelative(parent, sessionId),
    };
  }
}

/** Completed probe with an explicit negative result, not a successful read/search. */
export function readPathMissResult(miss: ReadPathMiss): ToolExecutionResult {
  return {
    result: {
      status: 'not_found',
      code: 'READ_PATH_NOT_FOUND',
      recoverable: true,
      path: miss.path,
      reason: miss.reason,
      ...(miss.suggestions ? { suggestions: miss.suggestions } : {}),
      suggestedCall: { toolId: 'file.list', args: { path: miss.nearestDirectory } },
      hint: 'The requested path was not found; no target content was read or searched. Discover an existing path before retrying; do not repeat the unchanged call.',
    },
    // The ordinary completed-tool presentation stays quiet; details remain
    // inspectable and the model receives the full structured recovery result.
    displaySummary: `Path not found: ${miss.path.slice(0, 240)}. Discover an existing path before retrying.`,
    artifacts: [],
  };
}
