import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './tools/exec-async.js';
import { resolveWorkspacePath, workspaceRoot } from './tools/workspace.js';

export const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Git includes staged, unstaged and untracked sources, never just HEAD. No checkout/stash is used. */
export async function workspaceFingerprint(sessionId: string, scope: string[] = ['.']): Promise<string> {
  const root = workspaceRoot(sessionId);
  const opts = { cwd: root, timeoutMs: 10_000, maxBufferBytes: 8 * 1024 * 1024 };
  const head = await runCommand('git', ['rev-parse', 'HEAD'], opts);
  const hash = createHash('sha256');
  if (head.status === 0) {
    const [diff, untracked] = await Promise.all([
      runCommand('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', '.'], opts),
      runCommand('git', ['ls-files', '--others', '--exclude-standard', '-z'], opts),
    ]);
    if (diff.status !== 0 || untracked.status !== 0 || diff.stdoutTruncated || untracked.stdoutTruncated)
      throw new Error('Cannot establish a complete workspace fingerprint.');
    hash.update(head.stdout).update(diff.stdout);
    for (const file of untracked.stdout.split('\0').filter(Boolean).sort()) {
      hash.update(file).update(await fs.readFile(path.join(root, file)));
    }
  } else {
    const visit = async (file: string): Promise<void> => {
      const stat = await fs.lstat(file).catch(() => null);
      hash.update(path.relative(root, file));
      if (!stat) { hash.update('<absent>'); return; }
      if (stat.isSymbolicLink()) { hash.update(await fs.readlink(file)); return; }
      if (stat.isDirectory()) {
        for (const name of (await fs.readdir(file)).sort()) {
          if (['.git', 'node_modules', 'dist', 'build', '.cache'].includes(name)) continue;
          await visit(path.join(file, name));
        }
      } else if (stat.isFile()) hash.update(await fs.readFile(file));
    };
    for (const file of [...new Set(scope)].sort()) await visit(resolveWorkspacePath(file, sessionId));
  }
  // Explicit paths also cover ignored sources edited by this work (e.g. generated examples).
  if (head.status === 0) for (const file of [...new Set(scope)].filter(p => p !== '.').sort()) {
    const resolved = resolveWorkspacePath(file, sessionId);
    const stat = await fs.lstat(resolved).catch(() => null);
    hash.update(file);
    if (!stat) hash.update('<absent>');
    else if (stat.isFile()) hash.update(await fs.readFile(resolved));
    else if (stat.isSymbolicLink()) hash.update(await fs.readlink(resolved));
  }
  return hash.digest('hex');
}
