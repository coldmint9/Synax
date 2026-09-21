import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime-sdk.js', () => ({ artifactSdkSource: () => 'window.synax={standalone:true};' }));
let root: string;
let pub: typeof import('../publisher.js');
let db: typeof import('../../../../db/index.js');
const context = () => ({ sessionId: 's1', projectId: 'p1', workspaceRoot: root });
const input = (key = 'first') => ({ sourcePath: 'index.html', title: 'Demo', sourceKind: 'html' as const, idempotencyKey: key });
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  process.env.DATA_ROOT = path.join(root, 'data'); process.env.LOG_LEVEL = 'silent';
  vi.resetModules();
  db = await import('../../../../db/index.js');
  db.getRawSqlite().prepare(`INSERT INTO agent_runtime_sessions(id,project_id,profile_id,status,prompt,thinking_mode,created_at,updated_at) VALUES(?,?,'default','idle','','normal','now','now')`).run('s1', 'p1');
  pub = await import('../publisher.js');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Hello</h1><script>window.demo=1</script>');
});
afterEach(() => { db?.closeDb(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.DATA_ROOT; delete process.env.LOG_LEVEL; });

describe('immutable artifact publication', () => {
  it('publishes durable self-contained content, same-key retry and session-scoped reads', async () => {
    const one = await pub.publishArtifact(context(), input());
    fs.unlinkSync(path.join(root, 'index.html'));
    expect((await pub.publishArtifact(context(), input())).revisionId).toBe(one.revisionId);
    expect(pub.listArtifacts('s1')).toEqual([one]);
    expect(pub.getArtifactSource('s1', one.revisionId)[0].content).toContain('Hello');
    expect(pub.getArtifactBundle('s1', one.revisionId).html).toContain('Content-Security-Policy');
    expect(() => pub.getArtifactBundle('s2', one.revisionId)).toThrowError(/not found/i);
    db.closeDb();
    expect(pub.getArtifactBundle('s1', one.revisionId).html).toContain('Hello');
  });
  it('CAS allows one concurrent update, retains old source, detects changed idempotency payload', async () => {
    const one = await pub.publishArtifact(context(), input());
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>Two</h1>');
    const next = { ...input('two'), artifactId: one.artifactId, baseRevisionId: one.revisionId };
    const results = await Promise.allSettled([pub.publishArtifact(context(), next), pub.publishArtifact(context(), { ...next, idempotencyKey: 'three' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(pub.listRevisions('s1', one.artifactId)).toHaveLength(2);
    expect(pub.getArtifactSource('s1', one.revisionId)[0].content).toContain('Hello');
    await expect(pub.publishArtifact(context(), { ...input(), title: 'Changed' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('state compare-and-swap, validation and deletion', async () => {
    const one = await pub.publishArtifact(context(), input());
    const state = { privateState: { x: 1 }, modelState: null, controls: {}, schemaVersion: 1 };
    expect(pub.getArtifactState('s1', one.revisionId).etag).toBe(0);
    expect(pub.saveArtifactState('s1', one.revisionId, state, 0).etag).toBe(1);
    expect(() => pub.saveArtifactState('s1', one.revisionId, state, 0)).toThrowError(/conflict/i);
    expect(() => pub.saveArtifactState('s1', one.revisionId, { ...state, privateState: 'x'.repeat(17000) }, 1)).toThrowError(/limit/i);
    pub.deleteArtifact('s1', one.artifactId);
    expect(pub.listArtifacts('s1')).toEqual([]);
    expect(() => pub.getArtifactSource('s1', one.revisionId)).toThrowError(/not found/i);
  });
  it.each(['<iframe src="https://example.com"></iframe>', '<script src="https://example.com/a.js"></script>', '<meta http-equiv="refresh" content="0;url=https://example.com">', '<img src="https://example.com/a.png">', '<button onclick="alert(1)">X</button>'])('rejects unsafe HTML: %s', async html => {
    fs.writeFileSync(path.join(root, 'index.html'), html);
    await expect(pub.publishArtifact(context(), input())).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(pub.listArtifacts('s1')).toEqual([]);
  });
});

it('same-key concurrent calls share one publication and one durable event', async () => {
  const [one, two] = await Promise.all([pub.publishArtifact(context(), input()), pub.publishArtifact(context(), input())]);
  expect(one.revisionId).toBe(two.revisionId);
  expect(pub.pendingArtifactEvents('s1')).toHaveLength(1);
  pub.acknowledgeArtifactEvent('s1', pub.pendingArtifactEvents('s1')[0].id);
  expect(pub.pendingArtifactEvents('s1')).toEqual([]);
});
it('rejects session impersonation, missing update bases and cross-session mutation', async () => {
  await expect(pub.publishArtifact({ ...context(), projectId: 'other' }, input())).rejects.toMatchObject({code:'ARTIFACT_NOT_FOUND'});
  const one = await pub.publishArtifact(context(), input());
  await expect(pub.publishArtifact(context(), { ...input('x'), artifactId: one.artifactId })).rejects.toMatchObject({code:'INVALID_SOURCE'});
  expect(() => pub.saveArtifactState('s2', one.revisionId, {privateState:null, modelState:null, controls:{},schemaVersion:1},0)).toThrow();
  expect(() => pub.deleteArtifact('s2', one.artifactId)).toThrow();
  expect(() => pub.listRevisions('s2', one.artifactId)).toThrow();
});
it('protects revision bytes from UPDATE and preserves them on legacy session REPLACE', async () => {
  const one = await pub.publishArtifact(context(), input());
  expect(() => db.getRawSqlite().prepare("UPDATE agent_artifact_revisions SET bundle_html='tampered' WHERE id=?").run(one.revisionId)).toThrow(/immutable/i);
  db.getRawSqlite().prepare(`INSERT OR REPLACE INTO agent_runtime_sessions(id,project_id,profile_id,status,prompt,thinking_mode,created_at,updated_at) VALUES(?,?,'default','idle','','normal','now','now')`).run('s1','p1');
  expect(pub.getArtifactBundle('s1',one.revisionId).html).toContain('Hello');
  db.getRawSqlite().prepare('DELETE FROM agent_runtime_sessions WHERE id=?').run('s1');
  expect(pub.listArtifacts('s1')).toEqual([]);
  expect(db.getRawSqlite().prepare('SELECT count(*) AS count FROM agent_artifact_revisions').get()).toMatchObject({count:0});
});
it('rejects state prototype pollution and non-JSON data', async () => {
  const one = await pub.publishArtifact(context(), input());
  for (const privateState of [JSON.parse('{"__proto__":{"polluted":true}}'), {bad:Infinity}, {bad:undefined}, {get bad(){throw new Error('must not execute')}}]) {
    expect(() => pub.saveArtifactState('s1',one.revisionId,{privateState,modelState:null,controls:{},schemaVersion:1},0)).toThrow();
  }
  expect(pub.getArtifactState('s1',one.revisionId).etag).toBe(0);
});
it('exports offline HTML and source ZIP without injecting saved private state or IDs', async () => {
  const one = await pub.publishArtifact(context(), input());
  pub.saveArtifactState('s1',one.revisionId,{privateState:'PRIVATE-SECRET',modelState:'MODEL-SECRET',controls:{},schemaVersion:1},0);
  const { exportArtifact } = await import('../export.js');
  const html = exportArtifact('s1',one.revisionId,'html');
  expect(html.filename).toBe('Demo-v1.html'); expect(html.content).toContain('Hello');
  const source = exportArtifact('s1',one.revisionId,'source');
  expect(source.mediaType).toBe('application/zip');
  const bytes = Buffer.from(source.content);
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.toString()).toContain('source/index.html');
  expect(bytes.toString()).toContain('preview.html'); expect(bytes.toString()).toContain('LICENSES.txt');
  for (const secret of ['PRIVATE-SECRET','MODEL-SECRET',one.revisionId,one.artifactId,root]) { expect(bytes.toString()).not.toContain(secret); expect(html.content).not.toContain(secret); }
  fs.writeFileSync(path.join(root,'export.zip'),bytes);
  // Independent ZIP reader validates CRC, member names and offline preview bytes.
  const { execFileSync } = await import('node:child_process');
  expect(execFileSync('python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert b"Hello" in z.read("preview.html"); print("ok")',path.join(root,'export.zip')],{encoding:'utf8'}).trim()).toBe('ok');
});
it('recovers expired builds from immutable captured bytes after workspace deletion', async () => {
  const store = await import('../store.js');
  const { readSnapshot } = await import('../snapshot.js');
  const attempt = store.beginBuild(context(), input());
  store.persistBuildSnapshot(attempt.id, readSnapshot(root,'index.html').files());
  db.getRawSqlite().prepare('UPDATE agent_artifact_builds SET lease_until=0 WHERE id=?').run(attempt.id);
  fs.unlinkSync(path.join(root,'index.html'));
  db.closeDb();
  expect(await pub.resumeArtifactBuilds()).toBe(1);
  const revisions = pub.listArtifacts('s1'); expect(revisions).toHaveLength(1);
  expect(pub.getArtifactBundle('s1',revisions[0].revisionId).html).toContain('Hello');
  expect((await pub.publishArtifact(context(),input())).revisionId).toBe(revisions[0].revisionId);
  expect(pub.pendingArtifactEvents('s1')).toHaveLength(1);
});
it('marks incomplete recovered dependency graphs failed, and supports same-key republish', async () => {
  const store = await import('../store.js'); const { readSnapshot } = await import('../snapshot.js');
  fs.writeFileSync(path.join(root,'index.html'),'<script src="missing.js"></script>');
  const attempt = store.beginBuild(context(),input()); store.persistBuildSnapshot(attempt.id,readSnapshot(root,'index.html').files());
  db.getRawSqlite().prepare('UPDATE agent_artifact_builds SET lease_until=0 WHERE id=?').run(attempt.id);
  expect(await pub.resumeArtifactBuilds()).toBe(0); expect(pub.listArtifacts('s1')).toEqual([]);
  expect(db.getRawSqlite().prepare('SELECT status,error_code FROM agent_artifact_builds WHERE id=?').get(attempt.id)).toMatchObject({status:'failed',error_code:'INVALID_SOURCE'});
  fs.writeFileSync(path.join(root,'missing.js'),'window.ok=1');
  expect((await pub.publishArtifact(context(),input())).status).toBe('ready');
});
it('rolls back ready bytes/head/outbox together when commit fails', async () => {
  const one = await pub.publishArtifact(context(),input());
  db.getRawSqlite().exec("CREATE TRIGGER simulate_outbox_failure BEFORE INSERT ON agent_artifact_outbox BEGIN SELECT RAISE(ABORT,'simulated crash'); END;");
  await expect(pub.publishArtifact(context(),{...input('second'),artifactId:one.artifactId,baseRevisionId:one.revisionId})).rejects.toThrow();
  expect(pub.listRevisions('s1',one.artifactId)).toEqual([one]); expect(pub.listArtifacts('s1')).toEqual([one]);
  expect(pub.pendingArtifactEvents('s1')).toHaveLength(1);
  db.getRawSqlite().exec('DROP TRIGGER simulate_outbox_failure');
  expect((await pub.publishArtifact(context(),{...input('second'),artifactId:one.artifactId,baseRevisionId:one.revisionId})).revisionNumber).toBe(2);
});
it('enforces session and total quotas without deleting prior ready content', async () => {
  const { ARTIFACT_LIMITS } = await import('../contracts.js');
  const one = await pub.publishArtifact(context(),input());
  const sessionBytes = ARTIFACT_LIMITS.sessionBytes, totalBytes = ARTIFACT_LIMITS.totalBytes;
  try {
    (ARTIFACT_LIMITS as any).sessionBytes = 1;
    await expect(pub.publishArtifact(context(),input('session-quota'))).rejects.toMatchObject({code:'RESOURCE_LIMIT'});
    (ARTIFACT_LIMITS as any).sessionBytes = sessionBytes;
    (ARTIFACT_LIMITS as any).totalBytes = 1;
    await expect(pub.publishArtifact(context(),input('global-quota'))).rejects.toMatchObject({code:'RESOURCE_LIMIT'});
    expect(pub.getArtifactBundle('s1',one.revisionId).html).toContain('Hello');
  } finally { (ARTIFACT_LIMITS as any).sessionBytes = sessionBytes; (ARTIFACT_LIMITS as any).totalBytes = totalBytes; }
});
it('lists failed attempts and diagnostics without changing the ready head', async () => {
  const one = await pub.publishArtifact(context(),input());
  fs.writeFileSync(path.join(root,'index.html'),'<iframe></iframe>');
  await expect(pub.publishArtifact(context(),{...input('broken'),artifactId:one.artifactId,baseRevisionId:one.revisionId})).rejects.toMatchObject({code:'POLICY_BLOCKED'});
  const failed = pub.listArtifactBuilds('s1',one.artifactId).find(build=>build.status==='failed');
  expect(failed?.errorCode).toBe('POLICY_BLOCKED'); expect(failed?.diagnostics[0]).toContain('iframe');
  expect(pub.listArtifacts('s1')).toEqual([one]); expect(pub.listRevisions('s1',one.artifactId)).toEqual([one]);
  expect(pub.listArtifactBuilds('s2')).toEqual([]);
});
it('cancels in-flight publication without ready content or an outbox event', async () => {
  const controller = new AbortController();
  const ctx = {...context(),signal:controller.signal};
  const pending = pub.publishArtifact(ctx,input()); controller.abort();
  await expect(pending).rejects.toMatchObject({code:'BUILD_CANCELLED'});
  expect(pub.listArtifacts('s1')).toEqual([]); expect(pub.pendingArtifactEvents('s1')).toEqual([]);
  expect(pub.listArtifactBuilds('s1')[0]).toMatchObject({status:'failed',errorCode:'BUILD_CANCELLED'});
  await expect(pub.publishArtifact(ctx,input('pre-aborted'))).rejects.toMatchObject({code:'BUILD_CANCELLED'});
  expect(pub.listArtifactBuilds('s1')).toHaveLength(1);
});
it('keeps dependency filesystem identities out of HTML and ZIP preview exports', async () => {
  fs.writeFileSync(path.join(root,'private-check.tsx'),'import React from "react";export default function App(){return <p>Path-free React</p>}');
  const revision=await pub.publishArtifact(context(),{...input('private-check'),sourcePath:'private-check.tsx',sourceKind:'react'});
  const { exportArtifact }=await import('../export.js');
  const { createRequire }=await import('node:module');
  const modulesRoot=fs.realpathSync(path.dirname(path.dirname(createRequire(import.meta.url).resolve('react'))));
  const html=String(exportArtifact('s1',revision.revisionId,'html').content);
  const zip=Buffer.from(exportArtifact('s1',revision.revisionId,'source').content);
  const zipped=zip.toString('utf8');
  for(const location of [os.homedir(),modulesRoot,root]) {
    expect(html).not.toContain(location); expect(zipped).not.toContain(location);
    expect(html).not.toContain(location.replace(/[^\w$]/g,'_'));
    expect(zipped).not.toContain(location.replace(/[^\w$]/g,'_'));
  }
  fs.writeFileSync(path.join(root,'private-check.zip'),zip);
  const {execFileSync}=await import('node:child_process');
  const preview=execFileSync('python3',['-c','import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read("preview.html").decode())',path.join(root,'private-check.zip')],{encoding:'utf8',maxBuffer:12*1024*1024});
  expect(preview.trim()).toBe(html.trim());
  expect(preview).not.toContain(modulesRoot); expect(preview).not.toContain(os.homedir());
});
it('defers interrupted builds on compiler contention, but never auto-retries a real compile timeout', async () => {
  const store = await import('../store.js');
  const {readSnapshot} = await import('../snapshot.js');
  const attempt=store.beginBuild(context(),input());store.persistBuildSnapshot(attempt.id,readSnapshot(root,'index.html').files());
  db.getRawSqlite().prepare('UPDATE agent_artifact_builds SET lease_until=? WHERE id=?').run(Date.now()-1,attempt.id);
  expect(store.claimRecoverableBuilds()).toHaveLength(1);
  store.deferArtifactRecovery(attempt.id);
  expect(store.claimRecoverableBuilds()).toEqual([]);
  db.getRawSqlite().prepare('UPDATE agent_artifact_builds SET lease_until=? WHERE id=?').run(Date.now()-1,attempt.id);
  expect(store.claimRecoverableBuilds()).toHaveLength(1);
  const {ArtifactError}=await import('../contracts.js');
  store.failBuild(attempt.id,new ArtifactError('BUILD_TIMEOUT','Actual compile deadline'));
  expect(store.claimRecoverableBuilds()).toEqual([]);
});
