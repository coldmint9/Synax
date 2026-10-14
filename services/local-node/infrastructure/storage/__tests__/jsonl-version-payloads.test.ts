import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let root: string;
let close: (() => void) | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-jsonl-payloads-')); vi.stubEnv('DATA_ROOT', root); vi.stubEnv('SYNAX_TRANSCRIPT_STORAGE', 'jsonl'); vi.stubEnv('LOG_LEVEL','error'); vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); close?.(); fs.rmSync(root,{recursive:true,force:true}); vi.unstubAllEnvs(); });
async function setup() {
  const database = await import('../../database/index.js'); close = database.closeDb;
  const db = database.getRawSqlite();
  const { versionRepository } = await import('../../../modules/agent-runtime/checkpoints/version-runtime/bridge.js');
  const repo = versionRepository();
  return { db, repo };
}
it('flushes each touched pack once before SQL COMMIT and rejects failed flushes', async () => {
  const { db, repo } = await setup();
  const sync = vi.spyOn(fs,'fsyncSync');
  db.transaction(() => { for (let n=0;n<20;n++) repo.objects.put('chunk',Buffer.from(`chunk-${n}`)); })();
  // files + directories, never 20 individual chunk fsyncs.
  expect(sync.mock.calls.length).toBeLessThan(10);
  const before = repo.objects.stats();
  sync.mockImplementation(() => { throw new Error('injected durability failure'); });
  expect(() => db.transaction(() => repo.objects.put('chunk',Buffer.from('not acknowledged')))()).toThrow('durability failure');
  sync.mockRestore();
  expect(repo.objects.stats()).toEqual(before);
  const hash = repo.objects.put('chunk',Buffer.from('after rollback'));
  expect(repo.objects.get(hash).bytes.toString()).toBe('after rollback');
});
it('reclaims unreachable external JSONL payloads while preserving pinned checkpoint roots', async () => {
  const { db, repo } = await setup();
  const { VersionCollector } = await import('../../../modules/agent-runtime/checkpoints/version-store/gc.js');
  repo.create('s',{ id:'s',prompt:'test' });
  repo.put('s','messages','m',{ id:'m',sessionId:'s',role:'assistant',content:'body'.repeat(5000),metadata:{} });
  const cp=repo.capture('s','reply','m',null,0);
  repo.objects.put('chunk',Buffer.from('orphan'));
  new VersionCollector(repo.objects).collect({maxObjects:128,maxMs:1000,maxEdges:2048});
  repo.objects.collectPayloads(128);
  expect(repo.checkpoint('s',cp.id).messageId).toBe('m');
  expect(repo.get('s','messages','m')?.content).toBe('body'.repeat(5000));
  expect((db.prepare('SELECT count(*) AS n FROM conversation_v3_objects WHERE jsonl_payload=0').get() as {n:number}).n).toBe(0);
});
