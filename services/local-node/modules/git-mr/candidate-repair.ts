import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MergeRequest } from './contracts.js';
import { GitMrError } from './errors.js';
import { git, MAX_FILE_BYTES, safeWorktreeFile } from './repository.js';

export interface CandidateRepair {
  path: string;
  expectedRevision: string;
  edits: Array<{ oldText: string; newText: string }>;
}
export const MAX_REPAIR_ATTEMPTS = 3;

async function readBounded(handle: fs.FileHandle) {
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  if (size > MAX_FILE_BYTES) throw new GitMrError('Repair file exceeds 2 MiB.', 'FILE_TOO_LARGE');
  return buffer.subarray(0, size);
}

/** Only paths named by failed checks on this exact candidate are repairable. */
export async function repairDiagnostics(mr: MergeRequest) {
  if (mr.status !== 'check_failed' || !mr.worktree || !mr.candidateTree || !mr.candidateOid)
    throw new GitMrError('Repair requires a candidate with failed verification.', 'INVALID_STATE');
  const failures = mr.checkResults.filter(check => check.status === 'failed' && check.tree === mr.candidateTree);
  if (!failures.length) throw new GitMrError('No failed checks for this candidate.', 'STALE_CANDIDATE');
  const tracked = (await git(mr, ['ls-files', '-z'], { cwd: mr.worktree })).stdout.split('\0').filter(Boolean);
  const output = failures.map(check => check.output.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  // Match complete diagnostic locations, not arbitrary occurrences of a file
  // name in log prose. Supports tsc, compiler/test stack traces and Unix paths.
  const files = tracked.filter(file => {
    if (file.split('/').at(-1) === '.DS_Store') return false;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s("'])${escaped}(?:\\(\\d+(?:,\\d+)?\\)|:\\d+(?::\\d+)?)(?=[:\\s)]|$)`, 'm').test(output) ||
      new RegExp(`(?:^|[\\s("'])${mr.worktree!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${escaped}(?:\\(\\d+(?:,\\d+)?\\)|:\\d+(?::\\d+)?)(?=[:\\s)]|$)`, 'm').test(output);
  });
  return { candidateOid: mr.candidateOid, candidateTree: mr.candidateTree,
    attempts: mr.repairAttempts ?? 0, remainingAttempts: Math.max(0, MAX_REPAIR_ATTEMPTS - (mr.repairAttempts ?? 0)),
    files, checks: failures.map(check => ({ id: check.id, output: check.output.slice(-12_000) })) };
}

export async function readRepairFile(mr: MergeRequest, file: string, allowedFiles: string[]) {
  if (!allowedFiles.includes(file))
    throw new GitMrError('Only tracked files identified by current failed-check diagnostics can be repaired.', 'REPAIR_SCOPE');
  const destination = await safeWorktreeFile(mr, mr.worktree!, file);
  const stat = await fs.lstat(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new GitMrError('Repair requires a regular file.', 'UNSAFE_PATH');
  if (stat.size > MAX_FILE_BYTES) throw new GitMrError('Repair file exceeds 2 MiB.', 'FILE_TOO_LARGE');
  const handle = await fs.open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new GitMrError('Repair file changed while opening it.', 'STALE_DRAFT');
    bytes = await readBounded(handle);
  } finally { await handle.close(); }
  if (bytes.length > MAX_FILE_BYTES) throw new GitMrError('Repair file exceeds 2 MiB.', 'FILE_TOO_LARGE');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new GitMrError('Only UTF-8 text can be repaired.', 'UNSUPPORTED_CONFLICT'); }
  if (content.includes('\0')) throw new GitMrError('Binary files cannot be repaired as text.', 'UNSUPPORTED_CONFLICT');
  const revision = createHash('sha256').update(`${mr.candidateOid}\0${file}\0${stat.mode}\0`).update(bytes).digest('hex');
  return { path: file, destination, content, revision, mode: stat.mode };
}

/** Open the existing file without following a symlink, then recheck its exact
 * original bytes on that descriptor before replacing content. */
export async function replaceRepairFile(mr: MergeRequest, file: string, original: string, replacement: string) {
  const destination = await safeWorktreeFile(mr, mr.worktree!, file);
  const before = await fs.lstat(destination);
  if (!before.isFile() || before.isSymbolicLink()) throw new GitMrError('Repair requires a regular file.', 'UNSAFE_PATH');
  const handle = await fs.open(destination, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev ||
        !(await readBounded(handle)).equals(Buffer.from(original, 'utf8')))
      throw new GitMrError('Repair file changed before writing.', 'STALE_DRAFT');
    const bytes = Buffer.from(replacement, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
      if (!bytesWritten) throw new GitMrError('Repair write did not advance.', 'WRITE_FAILED');
      written += bytesWritten;
    }
    await handle.truncate(bytes.length);
  } finally { await handle.close(); }
}

export function applyRepairEdits(content: string, edits: CandidateRepair['edits']) {
  if (!edits.length || edits.length > 30) throw new GitMrError('Provide 1–30 exact replacements.', 'INVALID_INPUT', 400);
  for (const edit of edits) {
    if (!edit.oldText || edit.oldText === edit.newText)
      throw new GitMrError('Each repair must replace nonempty text with changed content.', 'INVALID_INPUT', 400);
    const start = content.indexOf(edit.oldText);
    if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0)
      throw new GitMrError('Repair text must match exactly once. Read the current diagnostic file first.', 'STALE_DRAFT');
    content = content.slice(0, start) + edit.newText + content.slice(start + edit.oldText.length);
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0'))
    throw new GitMrError('Repair result exceeds the text editing budget.', 'FILE_TOO_LARGE');
  if (/^(<{7,}|\|{7,}|={7,}|>{7,})(?:\s|$)/m.test(content))
    throw new GitMrError('Repair content contains conflict markers.', 'UNRESOLVED_CONTENT');
  return content;
}
