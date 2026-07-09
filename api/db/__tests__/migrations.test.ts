import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import NativeDatabase from 'libsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SYNAX_AGENT_SESSION_CHILD: process.env.SYNAX_AGENT_SESSION_CHILD,
};

let tempDir = '';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-migrations-'));
  process.env.DATA_ROOT = tempDir;
  process.env.LOG_LEVEL = 'warn';
  delete process.env.SYNAX_AGENT_SESSION_CHILD;
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
  process.env.SYNAX_AGENT_SESSION_CHILD = originalEnv.SYNAX_AGENT_SESSION_CHILD;
});

describe('runMigrations ledger', () => {
  it('applies each migration file only once on repeated open', async () => {
    const { getRawSqlite } = await import('../index.js');
    const dbPath = path.join(tempDir, 'context.db');

    const db1 = getRawSqlite(dbPath);
    const firstCount = (
      db1.prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(firstCount).toBeGreaterThan(0);

    const { closeDb } = await import('../index.js');
    closeDb();
    vi.resetModules();
    const { getRawSqlite: openAgain } = await import('../index.js');
    const db2 = openAgain(dbPath);

    const secondCount = (
      db2.prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(secondCount).toBe(firstCount);
  });

  it('bootstraps ledger for pre-existing databases without re-running migrations', async () => {
    const dbPath = path.join(tempDir, 'context.db');
    const sqlite = new NativeDatabase(dbPath);
    sqlite.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '25');
      CREATE TABLE wiki_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_commit_sha TEXT NOT NULL,
        working_tree_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ready',
        document_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'system'
      );
    `);
    sqlite.close();

    const { getRawSqlite } = await import('../index.js');
    getRawSqlite(dbPath);

    const ledger = getRawSqlite(dbPath)
      .prepare('SELECT file FROM _schema_migrations ORDER BY file')
      .all() as Array<{ file: string }>;
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.some((row) => row.file === '0020_wiki_drop_blocks.sql')).toBe(true);

    const blocks = getRawSqlite(dbPath)
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_blocks'")
      .get();
    expect(blocks).toBeUndefined();
  });

  it('skips migrations in agent session child processes', async () => {
    process.env.SYNAX_AGENT_SESSION_CHILD = '1';
    const dbPath = path.join(tempDir, 'context.db');
    const sqlite = new NativeDatabase(dbPath);
    sqlite.exec(`CREATE TABLE _schema_migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    sqlite.close();

    const { getRawSqlite } = await import('../index.js');
    getRawSqlite(dbPath);

    const count = (
      getRawSqlite(dbPath).prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
