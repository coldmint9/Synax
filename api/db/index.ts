import { assertDatabaseWriteAllowed } from '../lib/execution-context.js';

import { createClient, type Client, type InStatement, type TransactionMode } from '@libsql/client';
import NativeDatabase from 'libsql';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATA_ROOT } from '../lib/env.js';
import { logger as pinoLogger } from '../lib/logger.js';
import * as schema from './schema.js';

export type ContextDb = LibSQLDatabase<typeof schema>;
export type SqliteTransaction = <Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
) => (...args: Args) => Result;
export type RawSqlite = NativeDatabase.Database & {
  transaction: SqliteTransaction;
  query: NativeDatabase.Database['prepare'];
};

let _sqlite: RawSqlite | null = null;
let _client: Client | null = null;
let _db: ContextDb | null = null;

const transactionStates = new WeakMap<NativeDatabase.Database, { depth: number; nextSavepointId: number }>();

function getTransactionState(sqlite: NativeDatabase.Database): { depth: number; nextSavepointId: number } {
  let state = transactionStates.get(sqlite);
  if (!state) {
    state = { depth: 0, nextSavepointId: 0 };
    transactionStates.set(sqlite, state);
  }
  return state;
}

function sqliteIsInTransaction(sqlite: NativeDatabase.Database): boolean {
  try {
    return sqlite.inTransaction;
  } catch {
    return false;
  }
}

function createTransaction(sqlite: NativeDatabase.Database): SqliteTransaction {
  return function transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
    return (...args: Args): Result => {
      const state = getTransactionState(sqlite);
      const useSavepoint = state.depth > 0 || sqliteIsInTransaction(sqlite);

      if (useSavepoint) {
        const savepoint = `Synax_tx_${state.nextSavepointId++}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        state.depth++;
        try {
          const result = fn(...args);
          sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (err) {
          try {
            sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          } finally {
            sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
          throw err;
        } finally {
          state.depth--;
        }
      }

      // Runtime checkpoints read before writing; reserve the writer before that read so
      // another process cannot invalidate a deferred transaction's snapshot upgrade.
      sqlite.exec('BEGIN IMMEDIATE');
      state.depth++;
      try {
        const result = fn(...args);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      } finally {
        state.depth--;
      }
    };
  };
}

function installSqliteCompat(sqlite: NativeDatabase.Database, databasePath: string): RawSqlite {
  const compat = sqlite as RawSqlite;
  const prepare = sqlite.prepare.bind(sqlite);
  const exec = sqlite.exec.bind(sqlite);
  const mutates = (sql: string) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql.replace(/--[^\n]*/g, ''));
  Object.defineProperty(compat, 'prepare', { configurable: true, value: (sql: string) => {
    const statement = prepare(sql);
    if (!mutates(sql)) return statement;
    const wrapped = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertDatabaseWriteAllowed(compat, databasePath);
        const result = value.apply(target, args);
        return result === target ? wrapped : result;
      };
    } });
    return wrapped;
  } });
  Object.defineProperty(compat, 'exec', { configurable: true, value: (sql: string) => {
    if (mutates(sql)) assertDatabaseWriteAllowed(compat, databasePath);
    return exec(sql);
  } });
  Object.defineProperty(compat, 'transaction', {
    configurable: true,
    value: createTransaction(sqlite),
  });
  if (typeof compat.query !== 'function') {
    Object.defineProperty(compat, 'query', {
      configurable: true,
      value: sqlite.prepare.bind(sqlite),
    });
  }
  return compat;
}

function resolveDbPath(): string {
  const dir = path.isAbsolute(DATA_ROOT)
    ? DATA_ROOT
    : path.resolve(process.cwd(), DATA_ROOT);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'context.db');
}

function resolveMigrationsDir(): string {
  // 兼容直接运行源码、bundled sidecar 与 packaged resources 路径
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, 'migrations');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* noop */
  }
  const candidates = [
    ...(process.argv[1] ? [
      path.join(path.dirname(process.argv[1]), 'migrations'),
      path.join(path.dirname(process.argv[1]), '..', 'migrations'),
    ] : []),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'api/db/migrations'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Runtime migration assets are missing from this build.');
  return found;
}

function hasExecutableSql(sql: string): boolean {
  return sql
    .replace(/--.*$/gm, '')
    .trim()
    .length > 0;
}

function configureSqlite(sqlite: NativeDatabase.Database): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

function ensureMigrationsTable(sqlite: NativeDatabase.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      file TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function isMigrationApplied(sqlite: NativeDatabase.Database, file: string): boolean {
  const row = sqlite
    .prepare('SELECT file FROM _schema_migrations WHERE file = ?')
    .get(file) as { file: string } | undefined;
  return row != null;
}

function markMigrationApplied(sqlite: NativeDatabase.Database, file: string): void {
  sqlite
    .prepare('INSERT OR IGNORE INTO _schema_migrations (file, applied_at) VALUES (?, ?)')
    .run(file, new Date().toISOString());
}

/** The ledger was introduced at 0025. Bootstrap only that historical baseline, never later DDL. */
function bootstrapMigrationLedger(sqlite: NativeDatabase.Database, files: string[]): void {
  const row = sqlite.prepare('SELECT COUNT(*) as c FROM _schema_migrations').get() as { c: number };
  if (row.c > 0) return;

  const legacy = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('wiki_snapshots', '_meta')")
    .all() as Array<{ name: string }>;
  if (legacy.length === 0) return;
  const runtimeTables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_runtime_sessions', 'agent_runtime_runs')")
    .all() as Array<{ name: string }>;
  if (runtimeTables.length !== 2) throw new Error('Legacy database predates the supported runtime baseline. Back up and migrate it with the matching Synax version; no migration ledger was guessed.');

  const baselineFiles = files.filter(file => Number.parseInt(file, 10) <= 25);
  const now = new Date().toISOString();
  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO _schema_migrations (file, applied_at) VALUES (?, ?)',
  );
  for (const file of baselineFiles) {
    insert.run(file, now);
  }
  pinoLogger.info({ count: baselineFiles.length }, 'context db: bootstrapped migration ledger for existing database');
}

function shouldRunMigrationsInThisProcess(): boolean {
  return process.env.SYNAX_AGENT_SESSION_CHILD !== '1'
    && process.env.SYNAX_WIKI_JOB_CHILD !== '1';
}

function runMigrations(sqlite: NativeDatabase.Database): void {
  ensureMigrationsTable(sqlite);

  if (!shouldRunMigrationsInThisProcess()) {
    return;
  }

  const dir = resolveMigrationsDir();
  if (!fs.existsSync(dir)) {
    pinoLogger.warn({ dir }, 'context db: migrations directory missing');
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  bootstrapMigrationLedger(sqlite, files);

  for (const f of files) {
    if (isMigrationApplied(sqlite, f)) {
      pinoLogger.info({ file: f }, 'context db: migration skipped (already applied)');
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!hasExecutableSql(sql)) {
      markMigrationApplied(sqlite, f);
      pinoLogger.info({ file: f }, 'context db: migration skipped (no-op)');
      continue;
    }
    try {
      sqlite.transaction(() => {
        // 0010 delegates this column to runtime repair; FTS backfill needs it
        // before the usual post-migration schema repair on fresh databases.
        if (f === '0039_session_fulltext_search.sql') {
          ensureColumn(sqlite, 'agent_runtime_sessions', 'title', 'title TEXT');
        }
        sqlite.exec(sql);
        markMigrationApplied(sqlite, f);
      })();
      pinoLogger.info({ file: f }, 'context db: migration applied');
    } catch (err) {
      pinoLogger.error({ file: f, err }, 'context db: migration failed');
      throw err;
    }
  }
}

function ensureColumn(sqlite: NativeDatabase.Database, table: string, column: string, ddl: string): void {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  if (!tableExists) return;
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  pinoLogger.info({ table, column }, 'context db: column added');
}

function migrateWikiEvaluationsToGoals(sqlite: NativeDatabase.Database): void {
  const legacy = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_evaluations'")
    .get() as { name: string } | undefined;
  if (!legacy) return;

  const columns = sqlite.prepare('PRAGMA table_info(wiki_evaluations)').all() as Array<{ name: string }>;
  const hasDocumentId = columns.some((c) => c.name === 'document_id');
  const documentExpr = hasDocumentId ? 'document_id' : 'NULL';

  sqlite.exec(`
    INSERT OR IGNORE INTO wiki_goals (
      id, project_id, scope, document_id, content, anchor_json,
      status, plan_node_id, created_at, updated_at, resolved_at
    )
    SELECT
      id, project_id, 'document', ${documentExpr}, content, NULL,
      status, plan_node_id, created_at, updated_at, resolved_at
    FROM wiki_evaluations;
  `);
  sqlite.exec('DROP TABLE IF EXISTS wiki_evaluations');
  pinoLogger.info('context db: migrated wiki_evaluations → wiki_goals');
}

function ensureRuntimeSchema(sqlite: NativeDatabase.Database): void {
  migrateWikiEvaluationsToGoals(sqlite);
  ensureColumn(sqlite, 'agent_runtime_sessions', 'active_run_id', 'active_run_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'pending_resume_token', 'pending_resume_token TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'title', 'title TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'session_metadata_json', 'session_metadata_json TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'reasoning_effort', 'reasoning_effort TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'mcp_server_ids_json', "mcp_server_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'agent_runtime_messages', 'project_id', "project_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, 'agent_runtime_messages', 'sequence', 'sequence INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'agent_runtime_messages', 'turn_id', 'turn_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'run_id', 'run_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'step_id', 'step_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'provider_id', 'provider_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'model_id', 'model_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'tool_call_id', 'tool_call_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_messages', 'usage_json', "usage_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(sqlite, 'agent_runtime_messages', 'metadata_json', "metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(sqlite, 'agent_runtime_events', 'payload_json', "payload_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'run_id', 'run_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'step_id', 'step_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'model_tool_call_id', 'model_tool_call_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'mutability', "mutability TEXT NOT NULL DEFAULT 'read'");
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'args_hash', "args_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'input_ref_json', 'input_ref_json TEXT');
  ensureColumn(sqlite, 'agent_runtime_tool_calls', 'output_ref_json', 'output_ref_json TEXT');
  ensureColumn(sqlite, 'agent_runtime_permissions', 'run_id', 'run_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_permissions', 'step_id', 'step_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_permissions', 'patterns_json', "patterns_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'agent_runtime_permissions', 'user_reply', 'user_reply TEXT');
  ensureColumn(sqlite, 'agent_runtime_permissions', 'resume_token', 'resume_token TEXT');
  ensureColumn(sqlite, 'agent_runtime_permissions', 'metadata_json', "metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(sqlite, 'agent_runtime_artifacts', 'metadata_json', "metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(sqlite, 'agent_runtime_context_bundles', 'blocks_json', "blocks_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'agent_runtime_thinking_summaries', 'evidence_used_json', "evidence_used_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'wiki_refresh_tasks', 'draft_ids_json', "draft_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'wiki_refresh_tasks', 'affected_document_ids_json', "affected_document_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'wiki_documents', 'pipeline_stage', "pipeline_stage TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(sqlite, 'wiki_documents', 'content_md', "content_md TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, 'wiki_documents', 'references_json', "references_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'wiki_documents', 'search_text', "search_text TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, 'wiki_documents', 'manual_state', "manual_state TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(sqlite, 'wiki_documents', 'stale_state', "stale_state TEXT NOT NULL DEFAULT 'fresh'");
  ensureColumn(sqlite, 'wiki_documents', 'is_section', 'is_section INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'wiki_goals', 'last_session_id', 'last_session_id TEXT');
  ensureColumn(sqlite, 'wiki_plans', 'goal_ids_json', "goal_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, 'wiki_plan_nodes', 'goal_ids_json', "goal_ids_json TEXT NOT NULL DEFAULT '[]'");
  try {
    sqlite.exec(`UPDATE wiki_plans SET goal_ids_json = evaluation_ids_json WHERE goal_ids_json = '[]' AND evaluation_ids_json != '[]'`);
    sqlite.exec(`UPDATE wiki_plan_nodes SET goal_ids_json = evaluation_ids_json WHERE goal_ids_json = '[]' AND evaluation_ids_json != '[]'`);
  } catch { /* columns may not exist on fresh DB */ }
}

function getOrCreateRawSqlite(dbPath = resolveDbPath()): RawSqlite {
  if (_sqlite) return _sqlite;
  const sqlite = installSqliteCompat(new NativeDatabase(dbPath), dbPath);
  configureSqlite(sqlite);

  try {
    runMigrations(sqlite);
    ensureRuntimeSchema(sqlite);
  } catch (error) { sqlite.close(); throw error; }

  _sqlite = sqlite;
  pinoLogger.info({ dbPath }, 'context db: ready');
  return _sqlite;
}

function getOrCreateClient(dbPath = resolveDbPath()): Client {
  if (_client) return _client;
  _client = createClient({ url: pathToFileURL(dbPath).href });
  const client = _client;
  const execute = client.execute.bind(client);
  client.execute = ((statement: InStatement, args?: unknown) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) assertDatabaseWriteAllowed(getOrCreateRawSqlite(dbPath), dbPath);
    return (execute as (...input: unknown[]) => ReturnType<Client['execute']>)(statement, args);
  }) as Client['execute'];
  const batch = client.batch.bind(client);
  client.batch = ((statements: Parameters<Client['batch']>[0], mode?: Parameters<Client['batch']>[1]) => {
    assertDatabaseWriteAllowed(getOrCreateRawSqlite(dbPath), dbPath);
    return batch(statements, mode);
  }) as Client['batch'];
  const transaction = client.transaction.bind(client);
  client.transaction = (async (mode?: TransactionMode) => {
    const tx = await (transaction as (mode?: TransactionMode) => ReturnType<Client['transaction']>)(mode);
    const executeTx = tx.execute.bind(tx);
    tx.execute = ((statement: InStatement, args?: unknown) => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) assertDatabaseWriteAllowed(getOrCreateRawSqlite(dbPath), dbPath);
      return (executeTx as (...input: unknown[]) => ReturnType<Client['execute']>)(statement, args);
    }) as typeof tx.execute;
    const commit = tx.commit.bind(tx);
    tx.commit = async () => { assertDatabaseWriteAllowed(getOrCreateRawSqlite(dbPath), dbPath); return commit(); };
    return tx;
  }) as Client['transaction'];
  return client;
}

export function getDb(): ContextDb {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  getOrCreateRawSqlite(dbPath);
  const client = getOrCreateClient(dbPath);
  _db = drizzle({ client, schema });
  return _db;
}

export function assertRuntimeExecutionCurrent(): void { assertDatabaseWriteAllowed(getRawSqlite(), resolveDbPath()); }

export function getRawSqlite(): RawSqlite {
  return getOrCreateRawSqlite();
}

export function tryGetRawSqlite(): RawSqlite | null { return _sqlite; }

export function closeDb(): void {
  if (_client) {
    _client.close();
  }
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch {
      /* noop */
    }
  }
  _client = null;
  _sqlite = null;
  _db = null;
}

export { schema };
