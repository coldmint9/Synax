import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitMrService } from '../service.js';
import { GitMrStore } from '../store.js';
import type { MergeRequest } from '../contracts.js';
import { CONFLICT_PACKET_BYTES } from '../conflict-packet.js';

let root: string, repo: string, service: GitMrService;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (message: string) => { git('add', '.'); git('commit', '-m', message); };
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const body = (brand: string, first = 'first', last = 'last') => `${first}\n${'unchanged long line\n'.repeat(300)}brand=${brand}\n${'shared context\n'.repeat(300)}${last}\n`;
async function prepare(checks: MergeRequest['checks'] = [], count = 2) {
  for (let i = 0; i < count; i++) write(`file${i}.ts`, body('base'));
  write('helper.ts', 'export const ready = false;\n'); commit('base');
  git('checkout', '-b', 'feature/source');
  for (let i = 0; i < count; i++) write(`file${i}.ts`, body('source', 'source-only improvement'));
  commit('source'); git('checkout', '-b', 'integration', 'main');
  for (let i = 0; i < count; i++) write(`file${i}.ts`, body('target', 'first', 'target-only improvement'));
  commit('target'); git('checkout', 'main');
  const mr = await service.create('project', { kind: 'host', path: repo }, { title: 'Smart merge', target: 'integration', sources: ['feature/source'], strategy: 'merge_commit', checks });
  return service.prepare('project', mr.id, mr.version);
}
const decisions = (packet: Awaited<ReturnType<GitMrService['conflictPacket']>>) => packet.files.map(file => ({
  fileId: file.fileId, expectedRevision: file.revision, hunks: file.hunks.map(hunk => ({ hunkId: hunk.id, choice: 'target' as const })),
}));
const failingCheck = { id: 'typecheck', executable: process.execPath, args: ['-e',
  "if(require('fs').readFileSync('helper.ts','utf8').includes('false')){console.error('helper.ts(1,1): error TS18046: wrong value');process.exit(1)}"], timeoutMs: 10000 };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-smart-merge-')); repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  service = new GitMrService(new GitMrStore(path.join(root, 'state')));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('smart merge with real Git', { timeout: 60000 }, () => {
  it('packs nine conflicts compactly and preserves non-conflicting changes from both branches in one batch', async () => {
    let mr = await prepare([], 9);
    const packet = await service.conflictPacket('project', mr.id);
    expect(packet.files).toHaveLength(9);
    expect(packet.files.every(file => file.mode === 'hunks' && file.hunks.length === 1)).toBe(true);
    const size = Buffer.byteLength(JSON.stringify(packet));
    expect(size).toBeLessThan(CONFLICT_PACKET_BYTES);
    expect(size).toBeLessThan(Buffer.byteLength(body('base')) * 3 * 9 * 0.2);
    const target = git('rev-parse', 'integration');
    mr = await service.resolveBatch('project', mr.id, mr.version, decisions(packet));
    expect((await service.files('project', mr.id)).some(file => file.conflicted)).toBe(false);
    for (let i = 0; i < 9; i++) expect(fs.readFileSync(path.join(mr.worktree!, `file${i}.ts`), 'utf8'))
      .toBe(body('target', 'source-only improvement', 'target-only improvement'));
    mr = await service.continue('project', mr.id, mr.version);
    expect(mr.status).toBe('ready'); expect(git('rev-parse', 'integration')).toBe(target);
  });
  it('rejects a stale last file before writing the first file', async () => {
    const mr = await prepare();
    const packet = await service.conflictPacket('project', mr.id);
    const before = fs.readFileSync(path.join(mr.worktree!, 'file0.ts'), 'utf8');
    const batch = decisions(packet); batch[1].expectedRevision = 'stale';
    await expect(service.resolveBatch('project', mr.id, mr.version, batch)).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    expect(fs.readFileSync(path.join(mr.worktree!, 'file0.ts'), 'utf8')).toBe(before);
    expect((await service.files('project', mr.id)).filter(file => file.conflicted)).toHaveLength(2);
  });
  it('rejects an external edit between reading the visible draft and preparing the raw write revision', async () => {
    const mr = await prepare(); const packet = await service.conflictPacket('project', mr.id);
    const read = service.file.bind(service);
    vi.spyOn(service, 'file').mockImplementationOnce(async (...args) => {
      const file = await read(...args);
      fs.appendFileSync(path.join(mr.worktree!, file.path), 'external change\n');
      return file;
    });
    await expect(service.resolveBatch('project', mr.id, mr.version, decisions(packet))).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    expect(fs.readFileSync(path.join(mr.worktree!, packet.files[0].path), 'utf8')).toContain('external change');
    expect((await service.files('project', mr.id)).filter(file => file.conflicted)).toHaveLength(2);
  });
  it('fences each write and retains completed decisions after an interruption', async () => {
    const mr = await prepare(); const packet = await service.conflictPacket('project', mr.id);
    let calls = 0;
    await expect(service.resolveBatch('project', mr.id, mr.version, decisions(packet), async () => {
      if (++calls === 4) throw new Error('worker stopped');
    })).rejects.toThrow('worker stopped');
    expect((await service.files('project', mr.id)).filter(file => file.conflicted)).toHaveLength(1);
    expect(git('rev-parse', 'integration')).toBe(mr.targetOid);
  });
  it('pages conflict files without dropping remaining decisions', async () => {
    const mr = await prepare();
    const first = await service.conflictPacket('project', mr.id, { limit: 1 });
    expect(first.nextOffset).toBe(1);
    const second = await service.conflictPacket('project', mr.id, { offset: first.nextOffset! });
    expect(second.files[0].fileId).not.toBe(first.files[0].fileId); expect(second.nextOffset).toBeNull();
  });
  it('repairs a diagnostic file outside the merge diff, invalidates checks and verifies the new candidate', async () => {
    let mr = await prepare([failingCheck]);
    mr = await service.resolveBatch('project', mr.id, mr.version, decisions(await service.conflictPacket('project', mr.id)));
    mr = await service.continue('project', mr.id, mr.version);
    expect((await service.files('project', mr.id)).some(file => file.path === 'helper.ts')).toBe(false);
    mr = await service.checks('project', mr.id, mr.version); expect(mr.status).toBe('check_failed');
    const original = mr.candidateOid;
    expect((await service.repairContext('project', mr.id)).files).toEqual(['helper.ts']);
    const read = await service.repairRead('project', mr.id, 'helper.ts');
    await expect(service.repairRead('project', mr.id, 'file0.ts')).rejects.toMatchObject({ code: 'REPAIR_SCOPE' });
    await expect(service.repairRead('project', mr.id, '../helper.ts')).rejects.toMatchObject({ code: 'REPAIR_SCOPE' });
    await expect(service.repairCandidate('project', mr.id, mr.version, [{ path: 'helper.ts', expectedRevision: 'stale', edits: [{ oldText: 'false', newText: 'true' }] }])).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    mr = await service.get('project', mr.id);
    mr = await service.repairCandidate('project', mr.id, mr.version, [{ path: 'helper.ts', expectedRevision: read.revision, edits: [{ oldText: 'false', newText: 'true' }] }]);
    expect(mr.status).toBe('ready'); expect(mr.candidateOid).not.toBe(original);
    expect(mr.checkResults).toEqual([]); expect(mr.repairAttempts).toBe(1);
    expect(git('rev-parse', 'integration')).toBe(mr.targetOid);
    mr = await service.checks('project', mr.id, mr.version); expect(mr.checkResults[0].status).toBe('passed');
    mr = await service.finalize('project', mr.id, mr.version);
    expect(git('show', 'integration:helper.ts')).toContain('true'); expect(mr.status).toBe('merged');
    expect(git('show', 'main:helper.ts')).toContain('false');
  });
  it('rolls back only its own candidate writes if the worker is stopped before commit', async () => {
    let mr = await prepare([failingCheck]);
    mr = await service.resolveBatch('project', mr.id, mr.version, decisions(await service.conflictPacket('project', mr.id)));
    mr = await service.continue('project', mr.id, mr.version); mr = await service.checks('project', mr.id, mr.version);
    const read = await service.repairRead('project', mr.id, 'helper.ts'); let calls = 0;
    await expect(service.repairCandidate('project', mr.id, mr.version, [{ path: 'helper.ts', expectedRevision: read.revision, edits: [{ oldText: 'false', newText: 'true' }] }], async () => {
      if (++calls === 4) throw new Error('worker stopped');
    })).rejects.toThrow('worker stopped');
    expect(fs.readFileSync(path.join(mr.worktree!, 'helper.ts'), 'utf8')).toBe(read.content);
    expect(git('-C', mr.worktree!, 'status', '--porcelain')).toBe('');
    expect((await service.get('project', mr.id)).candidateOid).toBe(mr.candidateOid);
  });
  it('enforces the repair budget across re-entry and recovers a committed repair whose receipt was interrupted', async () => {
    let mr = await prepare([failingCheck]);
    mr = await service.resolveBatch('project', mr.id, mr.version, decisions(await service.conflictPacket('project', mr.id)));
    mr = await service.continue('project', mr.id, mr.version); mr = await service.checks('project', mr.id, mr.version);
    const read = await service.repairRead('project', mr.id, 'helper.ts');
    mr.repairAttempts = 3; mr = await service.store.save(mr);
    await expect(service.repairCandidate('project', mr.id, mr.version, [{ path: 'helper.ts', expectedRevision: read.revision,
      edits: [{ oldText: 'false', newText: 'true' }] }])).rejects.toMatchObject({ code: 'REPAIR_LIMIT' });
    mr = await service.get('project', mr.id);
    const message = `Repair merge verification (Synax ${mr.id} #3)`;
    mr.repair = { parentOid: mr.candidateOid!, paths: ['helper.ts'], message }; mr.status = 'interrupted'; await service.store.save(mr);
    fs.writeFileSync(path.join(mr.worktree!, 'helper.ts'), 'export const ready = true;\n');
    git('-C', mr.worktree!, 'add', 'helper.ts'); git('-C', mr.worktree!, 'commit', '-m', message);
    const repairedOid = git('-C', mr.worktree!, 'rev-parse', 'HEAD');
    mr = await service.resume('project', mr.id, mr.version);
    expect(mr).toMatchObject({ status: 'ready', candidateOid: repairedOid, checkResults: [], repairAttempts: 3 });
    expect(mr.repair).toBeUndefined(); expect(git('rev-parse', 'integration')).toBe(mr.targetOid);
    mr = await service.checks('project', mr.id, mr.version); expect(mr.checkResults[0].status).toBe('passed');
  });
});
