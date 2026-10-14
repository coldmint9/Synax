import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let root: string;
const originalRoot = process.env.DATA_ROOT;
const originalLevel = process.env.LOG_LEVEL;
let close: (() => void) | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-owner-'));
  process.env.DATA_ROOT = root;
  process.env.LOG_LEVEL = 'error';
  vi.resetModules();
});
afterEach(async () => {
  close?.(); close = undefined;
  const { stopStorageOwner } = await import('../owner-client.js');
  stopStorageOwner();
  if (originalRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = originalRoot;
  if (originalLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = originalLevel;
  fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const { startStorageOwner } = await import('../owner-client.js');
  startStorageOwner(root);
  const module = await import('../index.js');
  close = module.closeDb;
  return module.getRawSqlite();
}
function child(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: globalThis.process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    process.stdout.on('data', data => output += data);
    process.stderr.on('data', data => error += data);
    process.on('error', reject);
    process.on('exit', status => status ? reject(new Error(error || `Child exited ${status}`)) : resolve(output));
  });
}
const databasePath = fileURLToPath(new URL('../index.ts', import.meta.url));
describe('single database owner', () => {
  it('preserves nested savepoints, binary values, rollback and paged iterators', async () => {
    const db = await setup();
    db.exec('CREATE TABLE owner_test(id INTEGER PRIMARY KEY,value BLOB)');
    db.transaction(() => {
      db.prepare('INSERT INTO owner_test VALUES(?,?)').run(1, Buffer.from('one'));
      expect(() => db.transaction(() => {
        db.prepare('INSERT INTO owner_test VALUES(?,?)').run(2, Buffer.from('two'));
        throw new Error('undo');
      })()).toThrow('undo');
    })();
    const row = db.prepare('SELECT value FROM owner_test').get() as { value: Uint8Array };
    expect(Buffer.from(row.value).toString()).toBe('one');
    db.transaction(() => { for (let n = 2; n < 260; n++) db.prepare('INSERT INTO owner_test VALUES(?,?)').run(n, Buffer.from('x')); })();
    expect([...db.prepare('SELECT id FROM owner_test ORDER BY id').iterate()]).toHaveLength(259);
    const reader = db.prepare('SELECT id,value FROM owner_test ORDER BY id').iterate();
    reader.next();
    db.prepare('UPDATE owner_test SET value=? WHERE id=250').run(Buffer.from('changed'));
    const snapshotRow = [...reader].find(row => (row as { id: number }).id === 250) as { value: ArrayBuffer };
    expect(Buffer.from(snapshotRow.value).toString()).toBe('x');
  }, 60_000);
  it('finalizes transactional iterators before committing the writer connection', async () => {
    const db = await setup();
    db.exec('CREATE TABLE iterator_commit_test(id INTEGER PRIMARY KEY, value TEXT)');
    for (let n = 0; n < 300; n++) db.prepare('INSERT INTO iterator_commit_test VALUES(?, ?)').run(n, `v${n}`);
    const result = db.transaction(() => {
      const rows = [...db.prepare('SELECT id, value FROM iterator_commit_test ORDER BY id').iterate()];
      expect(rows).toHaveLength(300);
      return rows.at(-1);
    })();
    expect(result).toMatchObject({ id: 299, value: 'v299' });
    db.prepare('INSERT INTO iterator_commit_test VALUES(?, ?)').run(301, 'after-commit');
    expect(db.prepare('SELECT count(*) AS n FROM iterator_commit_test').get()).toMatchObject({ n: 301 });
  }, 60_000);
  it('serializes transactions from concurrent processes without SQLite writer contention', async () => {
    const db = await setup();
    db.exec('CREATE TABLE owner_counter(n INTEGER); INSERT INTO owner_counter VALUES(0)');
    await Promise.all(Array.from({ length: 8 }, () => child(`
      const {getRawSqlite,closeDb}=await import(${JSON.stringify(databasePath)});
      const db=getRawSqlite();
      for(let n=0;n<16;n++) db.transaction(()=>{
        const value=db.prepare('SELECT n FROM owner_counter').get().n;
        db.prepare('UPDATE owner_counter SET n=?').run(value+1);
      })();
      closeDb();
    `)));
    expect(db.prepare('SELECT n FROM owner_counter').get()).toMatchObject({ n: 128 });
  }, 60_000);
  it('rolls back an abandoned transaction when its client process dies', async () => {
    const db = await setup();
    db.exec('CREATE TABLE killed_writer(value TEXT)');
    const writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const {getRawSqlite}=await import(${JSON.stringify(databasePath)});
      const db=getRawSqlite(); db.exec("BEGIN IMMEDIATE; INSERT INTO killed_writer VALUES('uncommitted')");
      console.log('transaction-open'); setInterval(()=>{},1000);
    `], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      writer.stdout.on('data', data => { if (String(data).includes('transaction-open')) resolve(); });
      writer.on('error', reject);
      writer.on('exit', () => reject(new Error('Writer exited before opening its transaction.')));
    });
    writer.kill('SIGKILL');
    await new Promise(resolve => writer.once('exit', resolve));
    expect(db.prepare('SELECT count(*) AS n FROM killed_writer').get()).toMatchObject({ n: 0 });
    db.prepare('INSERT INTO killed_writer VALUES(?)').run('next-owner');
    expect(db.prepare('SELECT value FROM killed_writer').get()).toMatchObject({ value: 'next-owner' });
  }, 60_000);
  it('replays production runtime output from files and preserves async Drizzle access', async () => {
    const db = await setup();
    const { getDb } = await import('../index.js');
    const { sql } = await import('drizzle-orm');
    expect(await getDb().all(sql`SELECT 42 AS answer`)).toMatchObject([{ answer: 42 }]);
    await getDb().run(sql`CREATE TABLE drizzle_probe(id INTEGER PRIMARY KEY, label TEXT)`);
    await getDb().run(sql`INSERT INTO drizzle_probe(label) VALUES('owner')`);
    expect(await getDb().all(sql`SELECT label FROM drizzle_probe`)).toMatchObject([{ label: 'owner' }]);
    const { resetAgentRuntimeFixtures, plannerSessionInput } = await import('../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js');
    resetAgentRuntimeFixtures();
    const { agentSessionRuntime } = await import('../../../modules/agent-runtime/session-runtime.js');
    const { agentRuntimeStore } = await import('../../../modules/agent-runtime/session-store.js');
    const { runtimeJournal } = await import('../../../modules/agent-runtime/runtime-journal.js');
    const { sessionLogClient } = await import('../../storage/log-client.js');
    const session = agentSessionRuntime.create(plannerSessionInput);
    const run = agentRuntimeStore.appendRun({ id: `run-${session.id}`, sessionId: session.id, status: 'running',
      startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 0,
      stopReason: null, model: null, metadata: {} });
    agentRuntimeStore.updateSession(session.id, { activeRunId: run.id });
    await runtimeJournal.appendDurable(session.id, run.id, [{ type: 'message_delta', runId: run.id, stepId: 'step', delta: 'durable output' }]);
    const records = await runtimeJournal.readDurable(session.id);
    expect(records[0].chunk).toMatchObject({ type: 'message_delta', delta: 'durable output' });
    expect((await runtimeJournal.snapshotDurable(session.id)).cursor).toBe(records[0].sequence);
    expect(db.prepare('SELECT count(*) AS n FROM agent_runtime_stream_records').get()).toMatchObject({ n: 0 });
    await sessionLogClient.close();
    const { versionRepository } = await import('../../../modules/agent-runtime/checkpoints/version-runtime/bridge.js');
    const { VersionCollector } = await import('../../../modules/agent-runtime/checkpoints/version-store/gc.js');
    const repository = versionRepository();
    repository.create('file-history', { id: 'file-history', prompt: 'original' });
    const body = 'durable version body '.repeat(2000);
    repository.put('file-history', 'messages', 'a', { id: 'a', sessionId: 'file-history', role: 'assistant', content: body, metadata: {} });
    const checkpoint = repository.capture('file-history', 'reply', 'a', null, 0);
    repository.put('file-history', 'messages', 'b', { id: 'b', sessionId: 'file-history', role: 'assistant', content: 'later '.repeat(2000), metadata: {} });
    repository.rollback('file-history', { checkpointId: checkpoint.id, revision: repository.head('file-history').revision, requestId: 'restore-file-body' });
    new VersionCollector(repository.objects).collect({ maxObjects: 128, maxMs: 20, maxEdges: 2048 });
    repository.objects.collectPayloads();
    expect(repository.get('file-history', 'messages', 'a')?.content).toBe(body);
    expect((db.prepare('SELECT count(*) AS n FROM conversation_v3_objects WHERE payload_ref IS NOT NULL').get() as { n: number }).n).toBeGreaterThan(0);
  }, 60_000);
  it('keeps file-log commits independent of an unrelated SQLite write transaction', async () => {
    const db = await setup();
    const { sessionLogClient } = await import('../../storage/log-client.js');
    const blocker = new NativeDatabase(path.join(root, 'context.db'));
    blocker.exec('BEGIN IMMEDIATE');
    let result;
    try { result = await sessionLogClient.append('a', 'one', [{ type: 'runtime.replay', payload: 'saved' }]); } finally { blocker.exec('ROLLBACK'); blocker.close(); }
    expect(result.lastSeq).toBe(1);
    expect((await sessionLogClient.read('a'))[0].payload).toBe('saved');
    expect(db.prepare('SELECT count(*) AS n FROM agent_runtime_stream_records').get()).toMatchObject({ n: 0 });
    await sessionLogClient.close();
  }, 60_000);
});
