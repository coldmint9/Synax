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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-sqlite-compat-'));
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
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
});

describe('SQLite compatibility helpers', () => {
  it('provides better-sqlite3-style transactions for node:sqlite', async () => {
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
});
