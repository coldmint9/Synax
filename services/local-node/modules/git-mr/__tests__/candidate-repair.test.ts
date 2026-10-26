import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyRepairEdits, readRepairFile, replaceRepairFile } from '../candidate-repair.js';
import type { MergeRequest } from '../contracts.js';

let root: string, mr: MergeRequest;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-repair-file-'));
  mr = { worktree: root, repository: root, candidateOid: 'candidate' } as MergeRequest;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('preserves UTF-8 BOM, CRLF and executable mode during a bounded repair', async () => {
  const content = '\ufefffirst\r\nfalse\r\ntail';
  fs.writeFileSync(path.join(root, 'script.ts'), content, { mode: 0o755 });
  const read = await readRepairFile(mr, 'script.ts', ['script.ts']);
  expect(read.content).toBe(content);
  const fixed = applyRepairEdits(read.content, [{ oldText: 'false', newText: 'true' }]);
  await replaceRepairFile(mr, 'script.ts', read.content, fixed);
  expect(fs.readFileSync(path.join(root, 'script.ts'), 'utf8')).toBe('\ufefffirst\r\ntrue\r\ntail');
  expect(fs.statSync(path.join(root, 'script.ts')).mode & 0o777).toBe(0o755);
});

it('refuses symlinks, path escapes, binary content and stale writes', async () => {
  fs.writeFileSync(path.join(root, 'file.ts'), 'old');
  fs.symlinkSync('file.ts', path.join(root, 'link.ts'));
  await expect(readRepairFile(mr, 'link.ts', ['link.ts'])).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await expect(readRepairFile(mr, '../file.ts', ['../file.ts'])).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(replaceRepairFile(mr, 'link.ts', 'old', 'new')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  fs.writeFileSync(path.join(root, 'file.ts'), 'new external data');
  await expect(replaceRepairFile(mr, 'file.ts', 'old', 'new')).rejects.toMatchObject({ code: 'STALE_DRAFT' });
  expect(fs.readFileSync(path.join(root, 'file.ts'), 'utf8')).toBe('new external data');
  fs.writeFileSync(path.join(root, 'file.ts'), Buffer.from([0, 1, 2]));
  await expect(readRepairFile(mr, 'file.ts', ['file.ts'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFLICT' });
});

it('rejects missing, ambiguous, unchanged and marker-containing replacements', () => {
  for (const edits of [
    [{ oldText: 'missing', newText: 'x' }], [{ oldText: 'a', newText: 'b' }],
    [{ oldText: 'aa', newText: 'aa' }], [{ oldText: 'aa', newText: '<<<<<<< HEAD\n' }],
  ]) expect(() => applyRepairEdits('aa', edits)).toThrow();
});
