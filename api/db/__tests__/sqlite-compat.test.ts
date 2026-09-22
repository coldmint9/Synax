import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

let tempDir = '';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-sqlite-compat-'));
  process.env.DATA_ROOT = tempDir;
  process.env.LOG_LEVEL = 'warn';
  vi.resetModules();
});

afterEach(async () => {
  const dbModule = await import('../index.js');
  dbModule.closeDb();
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (originalEnv.DATA_ROOT === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  if (originalEnv.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
});

describe('libsql raw helpers', () => {
  it('provides libsql raw transaction helpers', async () => {
    const { getRawSqlite } = await import('../index.js');
    const db = getRawSqlite();

    expect(typeof db.transaction).toBe('function');
    expect(typeof db.query).toBe('function');

    db.exec('CREATE TABLE tx_test (name TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO tx_test (name) VALUES (?)');

    const commitTx = db.transaction((name: string) => {
      insert.run(name);
      return `stored:${name}`;
    });
    expect(commitTx('committed')).toBe('stored:committed');

    const rollbackTx = db.transaction((name: string) => {
      insert.run(name);
      throw new Error('force rollback');
    });
    expect(() => rollbackTx('rolled-back')).toThrow('force rollback');

    const rows = db.query('SELECT name FROM tx_test ORDER BY name').all() as unknown as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(['committed']);
  });

  it('rolls back nested transactions with savepoints without aborting the outer transaction', async () => {
    const { getRawSqlite } = await import('../index.js');
    const db = getRawSqlite();

    db.exec('CREATE TABLE nested_tx_test (name TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO nested_tx_test (name) VALUES (?)');

    const outer = db.transaction(() => {
      insert.run('outer');
      const inner = db.transaction(() => {
        insert.run('inner');
        throw new Error('inner failed');
      });
      expect(() => inner()).toThrow('inner failed');
    });

    outer();

    const rows = db
      .query('SELECT name FROM nested_tx_test ORDER BY name')
      .all() as unknown as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(['outer']);
  });

  it('preserves SQLITE_FULL through nested version and compatibility transactions', async () => {
    const { getRawSqlite } = await import('../index.js');
    const { atomicVersionWrite } = await import('../../services/agent-runtime/checkpoints/version-store/transaction.js');
    const db = getRawSqlite();
    db.exec('CREATE TABLE full_tx_test (content BLOB)');
    const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
    const size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    db.exec(`PRAGMA max_page_count=${pages}`);
    let error: unknown;
    try {
      db.transaction(() => atomicVersionWrite(db, () => db.prepare('INSERT INTO full_tx_test VALUES(zeroblob(?))').run((free + 8) * size)))();
    } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: 'SQLITE_FULL' });
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM full_tx_test').get()).toMatchObject({ n: 0 });
    expect(() => db.prepare('INSERT INTO full_tx_test VALUES(NULL)').run()).toThrow(/reopen|unsafe/i);
  });

  it('does not let the compatibility wrapper commit after a failed version savepoint rollback', async () => {
    const { getRawSqlite } = await import('../index.js');
    const { atomicVersionWrite } = await import('../../services/agent-runtime/checkpoints/version-store/transaction.js');
    const db = getRawSqlite();
    db.exec('CREATE TABLE poisoned_tx_test (name TEXT)');
    const execute = db.exec.bind(db);
    let fail = true;
    const spy = vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (fail && sql.startsWith('ROLLBACK TO SAVEPOINT synax_version_')) { fail = false; throw new Error('injected rollback failure'); }
      return execute(sql);
    });
    try {
      expect(() => db.transaction(() => {
        try {
          atomicVersionWrite(db, () => { db.prepare("INSERT INTO poisoned_tx_test VALUES('must rollback')").run(); throw new Error('action failed'); });
        } catch { /* The outer wrapper must still reject COMMIT. */ }
      })()).toThrow(/reopen|unsafe/i);
      expect(db.prepare('SELECT count(*) AS n FROM poisoned_tx_test').get()).toMatchObject({ n: 0 });
    } finally { spy.mockRestore(); }
  });

});
