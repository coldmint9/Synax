import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileId, readFile, readFileSlice, releaseMergeFileCaches, mergeFileCacheStats } from '../files.js';
import { GitMrService } from '../service.js';
import { GitMrStore } from '../store.js';
import { MAX_FILE_PREVIEW_BYTES } from '../repository.js';
import * as repository from '../repository.js';
import { DATA_ROOT } from '../../../infrastructure/runtime/env.js';
import { createConversationGitRoutes } from '../../../transport/http/conversation-git.js';
import type { ConversationGitService } from '../../agent-runtime/conversation-git/service.js';
import { Hono } from 'hono';
import type { MergeRequest } from '../contracts.js';

let directory: string, repo: string, mr: MergeRequest, service: GitMrService;
const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function conflict(content: string) {
  const sides = [content, content + '// target\n', content + '// source\n'];
  const objects = sides.map(text => git(['hash-object', '-w', '--stdin'], text));
  git(['update-index', '--index-info'], objects.map((oid, index) => `100644 ${oid} ${index + 1}\tlarge.java\n`).join(''));
  await fs.writeFile(path.join(repo, 'large.java'), content + '// result\n');
  return sides;
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-large-merge-'));
  repo = path.join(directory, 'repo'); await fs.mkdir(repo);
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Large file test']); git(['config', 'user.email', 'large@example.test']);
  await fs.writeFile(path.join(repo, 'seed'), 'seed'); git(['add', 'seed']); git(['commit', '-m', 'seed']);
  const head = git(['rev-parse', 'HEAD']);
  mr = { id: path.basename(directory), projectId: 'large', title: 'Large file', target: 'main', targetOid: head, strategy: 'merge_commit',
    steps: [{ branch: 'main', oid: head, status: 'conflicted' }], status: 'conflicted', version: 1, currentStep: 0,
    repository: repo, commonDir: path.join(repo, '.git'), worktree: repo, location: { kind: 'host', path: repo },
    checks: [], checkResults: [], events: [], autoFinalize: false, allowCheckedOutTarget: false, createdAt: '', updatedAt: '' };
  service = new GitMrService(new GitMrStore(path.join(directory, 'state'))); await service.store.write('requests', mr);
});
afterEach(async () => { vi.restoreAllMocks(); if (mr) await releaseMergeFileCaches(mr.id); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

describe('bounded large merge content', { timeout: 90_000 }, () => {
  it('browses a 10 MiB / 100k-line text completely while enforcing the separate edit budget', async () => {
    const text = ('// ' + 'x'.repeat(103) + '\n').repeat(100_000);
    const sides = await conflict(text);
    const file = await service.file('large', mr.id, fileId('large.java'));
    expect(file.kind).toBe('text'); expect(file.contentState).toBe('complete'); expect(file.editable).toBe(false);
    expect(file.target).toBe(sides[1]); expect(file.target.split('\n').length).toBeGreaterThan(100_000);
    expect(file.byteSizes?.target).toBe(Buffer.byteLength(sides[1]));
    await expect(service.saveFile('large', mr.id, file.id, { expectedRevision: file.revision, content: 'small replacement', resolve: false })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
  it('uses bounded UTF-8 pages for a 24 MiB text and rejects stale revisions', async () => {
    const spooled = vi.spyOn(repository, 'spoolGitBlob');
    const text = '中abc\r\n'.repeat(3 * 1024 * 1024);
    await conflict(text);
    const file = await service.file('large', mr.id, fileId('large.java'));
    expect(file.kind).toBe('text'); expect(file.contentState).toBe('partial'); expect(file.editable).toBe(false);
    expect(Buffer.byteLength(file.target)).toBeLessThanOrEqual(MAX_FILE_PREVIEW_BYTES);
    expect(file.truncatedSides).toContain('target');
    const initialSpools = spooled.mock.calls.length;
    const page = await service.fileSlice('large', mr.id, file.id, { side: 'target', byteOffset: 17 * 1024 * 1024 + 1, maxBytes: 64 * 1024, expectedRevision: file.revision });
    expect(page.byteOffset).toBeGreaterThanOrEqual(17 * 1024 * 1024 + 1);
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(64 * 1024);
    expect(page.content).not.toContain('\ufffd'); expect(page.eof).toBe(false);
    const next = await service.fileSlice('large', mr.id, file.id, { side: 'target', byteOffset: page.nextByteOffset, maxBytes: 64 * 1024, expectedRevision: file.revision });
    expect(next.byteOffset).toBe(page.nextByteOffset);
    const tail = await service.fileSlice('large', mr.id, file.id, { side: 'target', byteOffset: page.totalBytes - 16, maxBytes: 64, expectedRevision: file.revision });
    expect(tail.eof).toBe(true); expect(tail.content).toContain('// target');
    expect(spooled).toHaveBeenCalledTimes(initialSpools);
    const adapter = { fileSlice: (_sessionId: string, _objectId: string, selectedId: string, input: Parameters<GitMrService['fileSlice']>[3], signal?: AbortSignal) => service.fileSlice('large', mr.id, selectedId, input, signal) };
    const http = new Hono(); http.route('/sessions/:sessionId/git-tasks', createConversationGitRoutes(adapter as unknown as ConversationGitService));
    const response = await http.request(`/sessions/owner/git-tasks/task/files/${file.id}/content?side=target&byteOffset=${page.totalBytes - 16}&maxBytes=64&expectedRevision=${file.revision}`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ content: tail.content, eof: true, totalBytes: page.totalBytes });
    await fs.appendFile(path.join(repo, 'large.java'), 'external edit');
    await expect(service.fileSlice('large', mr.id, file.id, { side: 'result', byteOffset: 0, maxBytes: 1024, expectedRevision: file.revision })).rejects.toMatchObject({ code: 'STALE_DRAFT' });
  });
  it('releases file indexes and metadata at the task boundary and respects aborted reads', async () => {
    await conflict('hello 世界\n');
    await readFile(mr, fileId('large.java'));
    expect(mergeFileCacheStats().indexEntries).toBeGreaterThan(0);
    expect(mergeFileCacheStats().indexBytes).toBeLessThanOrEqual(mergeFileCacheStats().indexLimitBytes);
    const aborted = new AbortController(); aborted.abort();
    await expect(readFileSlice(mr, fileId('large.java'), { side: 'result', byteOffset: 0, maxBytes: 1024 }, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await releaseMergeFileCaches(mr.id);
    expect(mergeFileCacheStats()).toMatchObject({ indexEntries: 0, indexBytes: 0, resultMetadataEntries: 0, inFlightBlobs: 0 });
  });
  it('evicts disk blobs by actual byte budget before admitting another immutable blob', async () => {
    const cache = path.join(DATA_ROOT, 'git-mr', 'content-cache'); await fs.mkdir(cache, { recursive: true });
    const keys = Array.from({ length: 5 }, (_, index) => `${index + 1}`.padStart(64, '0'));
    try {
      for (const key of keys) {
        const handle = await fs.open(path.join(cache, `${key}.blob`), 'w'); await handle.truncate(128 * 1024 * 1024); await handle.close();
        await fs.writeFile(path.join(cache, `${key}.json`), JSON.stringify({ bytes: 128 * 1024 * 1024, binary: false, digest: 'a'.repeat(64), oid: 'b'.repeat(40), accessedAt: Date.now() }));
      }
      await conflict('cache admission\n'); await readFile(mr, fileId('large.java'));
      let bytes = 0; for (const name of await fs.readdir(cache)) if (name.endsWith('.blob')) bytes += (await fs.stat(path.join(cache, name))).size;
      expect(bytes).toBeLessThanOrEqual(mergeFileCacheStats().diskLimitBytes);
    } finally { for (const key of keys) { await fs.unlink(path.join(cache, `${key}.blob`)).catch(() => undefined); await fs.unlink(path.join(cache, `${key}.json`)).catch(() => undefined); } }
  });
  it('waits for a shared cache writer by filesystem events and releases abort listeners', async () => {
    await conflict('shared writer\n');
    const locks = new GitMrStore(path.join(DATA_ROOT, 'git-mr-content-locks'));
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = locks.exclusive('content-cache', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const controller = new AbortController();
    const reading = readFile(mr, fileId('large.java'), false, controller.signal);
    const observed = reading.then(() => 'completed', error => error);
    try { await vi.waitFor(() => expect(mergeFileCacheStats().cacheLockWaiters).toBe(1), { timeout: 10_000 }); }
    finally { controller.abort(); release(); await held; }
    expect(await observed).toMatchObject({ name: 'AbortError' });
    expect(mergeFileCacheStats()).toMatchObject({ activeContentReads: 0, queuedContentReads: 0, inFlightBlobs: 0, cacheLockWaiters: 0 });
    expect((await readFile(mr, fileId('large.java'))).target).toContain('shared writer');
  });
});
