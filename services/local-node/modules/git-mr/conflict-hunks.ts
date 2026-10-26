import { createHash } from 'node:crypto';
import type { MergeFile } from './contracts.js';
import { GitMrError } from './errors.js';

export interface ConflictHunk {
  id: string;
  start: number;
  end: number;
  startLine: number;
  base?: string;
  target: string;
  source: string;
  before: string;
  after: string;
}
export interface HunkResolution {
  hunkId: string;
  choice?: 'base' | 'target' | 'source';
  content?: string;
}
export interface ConflictResolution {
  fileId: string;
  expectedRevision: string;
  hunks?: HunkResolution[];
  /** Whole-file choices are reserved for binary and structural conflicts. */
  choice?: 'target' | 'source' | 'delete';
}

/** Parse diff3/zdiff3/merge markers while preserving every byte outside a hunk.
 * Ambiguous or incomplete markers are rejected rather than guessed. */
export function conflictHunks(content: string): ConflictHunk[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hunks: ConflictHunk[] = [];
  let offset = 0;
  let open: { start: number; line: number; width: number; target: string; base?: string; source: string; part: 'target' | 'base' | 'source' } | undefined;
  const invalid = () => { throw new GitMrError('Conflict markers are incomplete or ambiguous; inspect this file before resolving it.', 'UNSUPPORTED_CONFLICT'); };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?:[ \t][^\r\n]*)?\r?\n?$/.exec(line);
    if (marker) {
      const kind = marker[1][0], width = marker[1].length;
      if (kind === '<') {
        if (open) invalid();
        open = { start: offset, line: index, width, target: '', source: '', part: 'target' };
      } else {
        if (!open || open.width !== width) { invalid(); return []; }
        if (kind === '|' && open.part === 'target') { open.part = 'base'; open.base = ''; }
        else if (kind === '=' && open.part !== 'source') open.part = 'source';
        else if (kind === '>' && open.part === 'source') {
          const end = offset + line.length;
          hunks.push({ id: createHash('sha256').update(`${open.start}\0${content.slice(open.start, end)}`).digest('hex').slice(0, 20),
            start: open.start, end, startLine: open.line + 1, base: open.base, target: open.target, source: open.source,
            before: lines.slice(Math.max(0, open.line - 5), open.line).join('').slice(-2000),
            after: lines.slice(index + 1, index + 6).join('').slice(0, 2000) });
          open = undefined;
        } else invalid();
      }
    } else if (open) {
      if (open.part === 'base') open.base += line;
      else open[open.part] += line;
    }
    offset += line.length;
  }
  if (open) invalid();
  return hunks;
}

export function resolveHunks(file: Pick<MergeFile, 'result' | 'kind' | 'editable'>, resolutions: HunkResolution[]) {
  if (file.kind !== 'text' || file.editable === false)
    throw new GitMrError('This file does not support bounded text resolution.', 'UNSUPPORTED_CONFLICT');
  const hunks = conflictHunks(file.result);
  const selected = new Map<string, string>();
  for (const resolution of resolutions) {
    const hunk = hunks.find(item => item.id === resolution.hunkId);
    if (!hunk || selected.has(resolution.hunkId))
      throw new GitMrError('Unknown or duplicate conflict block; reload the conflict packet.', 'STALE_DRAFT');
    if (resolution.choice ? resolution.content !== undefined : typeof resolution.content !== 'string')
      throw new GitMrError('Provide one hunk choice or replacement content.', 'INVALID_INPUT', 400);
    const content = resolution.choice ? hunk[resolution.choice] : resolution.content;
    if (content === undefined) throw new GitMrError('This conflict has no base side.', 'INVALID_INPUT', 400);
    if (/^(<{7,}|\|{7,}|={7,}|>{7,})(?:\s|$)/m.test(content))
      throw new GitMrError('Replacement content still contains conflict markers.', 'UNRESOLVED_CONTENT');
    selected.set(hunk.id, content);
  }
  if (!selected.size) throw new GitMrError('Select at least one conflict block.', 'INVALID_INPUT', 400);
  let content = file.result;
  for (const hunk of [...hunks].reverse()) {
    const replacement = selected.get(hunk.id);
    if (replacement !== undefined) content = content.slice(0, hunk.start) + replacement + content.slice(hunk.end);
  }
  return { content, resolve: selected.size === hunks.length, remaining: hunks.length - selected.size };
}
