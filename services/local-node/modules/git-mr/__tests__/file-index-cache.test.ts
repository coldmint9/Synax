import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MergeRequest } from '../contracts.js';
const mocks = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock('../repository.js', async () => ({ ...await vi.importActual<object>('../repository.js'), git: mocks.git }));
import { listFiles, mergeFileCacheStats, releaseMergeFileCaches } from '../files.js';
let root: string;
const ids: string[] = [];
const request = (id: string) => ({ id, repository: root, worktree: root, targetOid: 'target', commonDir: root, currentStep: 0, version: 1 } as MergeRequest);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-index-budget-')); await fs.writeFile(path.join(root, 'index'), 'index');
  const changed = Array.from({ length: 4000 }, (_, index) => `M\0src/file-${String(index).padStart(5, '0')}.java\0`).join('');
  mocks.git.mockImplementation(async (_mr, args: string[]) => ({ stdout: args[0] === 'rev-parse' ? path.join(root, 'index') : args[0] === 'diff' ? changed : '', stderr: '', status: 0 }));
});
afterEach(async () => { vi.restoreAllMocks(); for (const id of ids.splice(0)) await releaseMergeFileCaches(id); await fs.rm(root, { recursive: true, force: true }); mocks.git.mockReset(); });
it('bounds all task indexes by bytes and reuses an unchanged manifest without rescanning the repository', async () => {
  for (let index = 0; index < 8; index++) { const id = `budget-${index}`; ids.push(id); expect(await listFiles(request(id))).toHaveLength(4000); }
  const stats = mergeFileCacheStats(); expect(stats.indexBytes).toBeLessThanOrEqual(stats.indexLimitBytes); expect(stats.indexEntries).toBeLessThan(8);
  const previous = mocks.git.mock.calls.length; await listFiles(request(ids.at(-1)!)); await listFiles(request(ids.at(-1)!));
  expect(mocks.git.mock.calls).toHaveLength(previous);
  expect(mocks.git.mock.calls.filter(([, args]) => args[0] === 'ls-files').every(([, args]) => args.includes('--unmerged'))).toBe(true);
});
it('expires inactive indexes on access without a polling timer', async () => {
  ids.push('expiry'); await listFiles(request('expiry')); expect(mergeFileCacheStats().indexEntries).toBeGreaterThan(0);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
  expect(mergeFileCacheStats()).toMatchObject({ indexEntries: 0, indexBytes: 0 });
});
