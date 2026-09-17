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
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('runMigrations ledger', () => {
  it('applies each migration file only once on repeated open', async () => {
    const { getRawSqlite } = await import('../index.js');
    const dbPath = path.join(tempDir, 'context.db');

    const db1 = getRawSqlite();
    const firstCount = (
      db1.prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(firstCount).toBeGreaterThan(0);

    const { closeDb } = await import('../index.js');
    closeDb();
    vi.resetModules();
    const { getRawSqlite: openAgain } = await import('../index.js');
    const db2 = openAgain();

    const secondCount = (
      db2.prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(secondCount).toBe(firstCount);
  });

  it('bootstraps ledger for pre-existing databases without re-running migrations', async () => {
    const dbPath = path.join(tempDir, 'context.db');
    const sqlite = new NativeDatabase(dbPath);
    const migrations = path.resolve('api/db/migrations');
    for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql') && Number.parseInt(file, 10) <= 25).sort()) {
      sqlite.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
    }
    sqlite.exec(`INSERT INTO agent_runtime_sessions (id, project_id, profile_id, status, prompt, thinking_mode, created_at, updated_at)
      VALUES ('historical-session', 'project', 'explorer', 'paused', 'Preserve this request', 'standard', 'old', 'old');
      INSERT INTO agent_runtime_runs (id, session_id, status, started_at) VALUES ('historical-run', 'historical-session', 'blocked', 'old');
      INSERT INTO agent_runtime_messages (id, session_id, project_id, role, content, created_at) VALUES ('historical-message', 'historical-session', 'project', 'assistant', 'Preserve this answer', 'old');`);
    sqlite.close();

    const { getRawSqlite } = await import('../index.js');
    getRawSqlite();

    const ledger = getRawSqlite()
      .prepare('SELECT file FROM _schema_migrations ORDER BY file')
      .all() as Array<{ file: string }>;
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.some((row) => row.file === '0020_wiki_drop_blocks.sql')).toBe(true);

    const blocks = getRawSqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_blocks'")
      .get();
    expect(blocks).toBeUndefined();
    const db = getRawSqlite();
    expect(db.prepare("SELECT content FROM agent_runtime_messages WHERE id='historical-message'").get()).toMatchObject({ content: 'Preserve this answer' });
    expect(db.prepare("SELECT status FROM agent_runtime_sessions WHERE id='historical-session'").get()).toMatchObject({ status: 'completed' });
    expect(db.prepare("SELECT status FROM agent_runtime_runs WHERE id='historical-run'").get()).toMatchObject({ status: 'blocked' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_runtime_stream_records'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_arr_runtime_request'").get()).toBeTruthy();
    expect(ledger.some(row => row.file === '0029_runtime_stream_journal.sql')).toBe(true);

  });

  it('fails an unrecognized ancient schema without declaring new migrations applied or deleting data', async () => {
    const dbPath = path.join(tempDir, 'context.db');
    const legacy = new NativeDatabase(dbPath);
    legacy.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO _meta VALUES ('important', 'keep');");
    legacy.close();
    const { getRawSqlite } = await import('../index.js');
    expect(() => getRawSqlite()).toThrow(/Legacy database/);
    const unchanged = new NativeDatabase(dbPath);
    expect(unchanged.prepare('SELECT value FROM _meta').get()).toMatchObject({ value: 'keep' });
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM _schema_migrations').get()).toMatchObject({ count: 0 });
    unchanged.close();
  });

  it('skips migrations in agent session child processes', async () => {
    process.env.SYNAX_AGENT_SESSION_CHILD = '1';
    const dbPath = path.join(tempDir, 'context.db');
    const sqlite = new NativeDatabase(dbPath);
    sqlite.exec(`CREATE TABLE _schema_migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    sqlite.close();

    const { getRawSqlite } = await import('../index.js');
    getRawSqlite();

    const count = (
      getRawSqlite().prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
