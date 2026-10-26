import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { previewText, readWorkspacePreview } from '../workspace-preview.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'synax-preview-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('reads a bounded prefix of a huge sparse file without allocating it', async () => {
  const filename = path.join(directory, 'large.txt');
  const file = await open(filename, 'w');
  await file.write('prefix'); await file.truncate(1024 * 1024 * 1024); await file.close();
  const result = await readWorkspacePreview(filename, 1024);
  expect(result.truncated).toBe(true); expect(result.bytes.length).toBe(1024);
  expect(result.bytes.subarray(0, 6).toString()).toBe('prefix');
});
it('keeps an exact-limit file editable and avoids a split multibyte character in previews', async () => {
  const filename = path.join(directory, 'unicode.txt');
  await writeFile(filename, 'a中文');
  const partial = await readWorkspacePreview(filename, 5);
  expect(previewText(partial.bytes, partial.truncated)).toBe('a中');
  const exact = await readWorkspacePreview(filename, 7);
  expect(exact.truncated).toBe(false); expect(previewText(exact.bytes, exact.truncated)).toBe('a中文');
});
it('releases read slots and descriptors after validation or open failures', async () => {
  for (let i = 0; i < 10; i++) await expect(readWorkspacePreview(path.join(directory, 'missing'), 20)).rejects.toThrow();
  const filename = path.join(directory, 'ok'); await writeFile(filename, 'ok');
  expect((await readWorkspacePreview(filename, 20)).bytes.toString()).toBe('ok');
  await expect(readWorkspacePreview(directory, 20)).rejects.toThrow(/regular file/);
});
