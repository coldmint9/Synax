import type { MergeFile } from './contracts.js';
import { conflictHunks } from './conflict-hunks.js';
import { GitMrError } from './errors.js';

export interface ConflictPacketInput { offset?: number; limit?: number; fileId?: string; hunkOffset?: number }
export const CONFLICT_PACKET_BYTES = 64 * 1024;
const PREVIEW_CHARS = 1600;

/** Full blobs remain in Git; model context contains only decisions and nearby code. */
export function conflictFilePacket(file: MergeFile, hunkOffset = 0) {
  let reason = file.reason;
  let hunks: ReturnType<typeof conflictHunks> = [];
  if (file.kind === 'text' && file.editable !== false && !file.truncatedSides?.includes('result')) {
    try { hunks = conflictHunks(file.result); }
    catch (error) { if (!(error instanceof GitMrError)) throw error; reason = error.message; }
  }
  const mode = file.kind !== 'text' ? 'whole_file' : hunks.length ? 'hunks' : 'manual';
  const page = hunks.slice(hunkOffset, hunkOffset + 8).map(({ id, startLine, base, target, source, before, after }) => ({
    id, startLine, base: base?.slice(0, PREVIEW_CHARS), target: target.slice(0, PREVIEW_CHARS), source: source.slice(0, PREVIEW_CHARS),
    before: before.slice(-400), after: after.slice(0, 400),
    truncated: [base ?? '', target, source].some(value => value.length > PREVIEW_CHARS),
    characters: { base: base?.length, target: target.length, source: source.length },
  }));
  return { fileId: file.id, path: file.path, revision: file.revision, kind: file.kind, mode,
    baseExists: file.baseExists, targetExists: file.targetExists, sourceExists: file.sourceExists,
    reason: mode === 'manual' ? reason ?? 'No unambiguous text conflict blocks. Inspect the file with read.' : reason,
    hunks: page, totalHunks: hunks.length,
    nextHunkOffset: hunkOffset + page.length < hunks.length ? hunkOffset + page.length : null };
}
