// ---------------------------------------------------------------------------
// api/db/index.ts — SQLite 连接单例 + WAL 模式 + 迁移执行
//
// 职责：
//   1. 创建/打开 context.db（位于 DATA_ROOT/context.db）
//   2. 启用 WAL、foreign_keys、synchronous=NORMAL
//   3. 首次启动执行 migrations/*.sql
//   4. 暴露 drizzle 实例 + 原生 Bun SQLite 实例
//
// 设计要点：
//   - 单文件、单连接：Bun SQLite 是同步 API，一个进程一个连接足矣。
//   - 迁移采用幂等 DDL（CREATE TABLE IF NOT EXISTS），允许多次重复执行。
//   - _meta.schema_version 用于未来结构演进时选择对应迁移链路。
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite/driver';
import { DATA_ROOT } from '../lib/env.js';
import { logger as pinoLogger } from '../lib/logger.js';
import * as schema from './schema.js';

export type ContextDb = NodeSQLiteDatabase<typeof schema>;
export type SqliteTransaction = <Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
) => (...args: Args) => Result;
export type RawSqlite = DatabaseSync & {
  transaction: SqliteTransaction;
  query: DatabaseSync['prepare'];
};

let _sqlite: RawSqlite | null = null;
let _db: ContextDb | null = null;

const transactionStates = new WeakMap<DatabaseSync, { depth: number; nextSavepointId: number }>();

function getTransactionState(sqlite: DatabaseSync): { depth: number; nextSavepointId: number } {
  let state = transactionStates.get(sqlite);
  if (!state) {
    state = { depth: 0, nextSavepointId: 0 };
    transactionStates.set(sqlite, state);
  }
  return state;
}

function sqliteIsInTransaction(sqlite: DatabaseSync): boolean {
  try {
    return Boolean((sqlite as DatabaseSync & { isTransaction?: boolean }).isTransaction);
  } catch {
    return false;
  }
}

function createTransaction(sqlite: DatabaseSync): SqliteTransaction {
  return function transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
    return (...args: Args): Result => {
      const state = getTransactionState(sqlite);
      const useSavepoint = state.depth > 0 || sqliteIsInTransaction(sqlite);

      if (useSavepoint) {
        const savepoint = `synapse_tx_${state.nextSavepointId++}`;
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

      sqlite.exec('BEGIN');
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

function installSqliteCompat(sqlite: DatabaseSync): RawSqlite {
  const compat = sqlite as RawSqlite;
  if (typeof compat.transaction !== 'function') {
    Object.defineProperty(compat, 'transaction', {
      configurable: true,
      value: createTransaction(sqlite),
    });
  }
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
  const cwdCandidates = [
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'api/db/migrations'),
  ];
  return cwdCandidates.find((candidate) => fs.existsSync(candidate)) ?? cwdCandidates[1];
}

function hasExecutableSql(sql: string): boolean {
  return sql
    .replace(/--.*$/gm, '')
    .trim()
    .length > 0;
}

function configureSqlite(sqlite: DatabaseSync): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

function runMigrations(sqlite: DatabaseSync): void {
  const dir = resolveMigrationsDir();
  if (!fs.existsSync(dir)) {
    pinoLogger.warn({ dir }, 'context db: migrations directory missing');
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!hasExecutableSql(sql)) {
      pinoLogger.info({ file: f }, 'context db: migration skipped (no-op)');
      continue;
    }
    try {
      sqlite.exec(sql);
      pinoLogger.info({ file: f }, 'context db: migration applied');
    } catch (err) {
      pinoLogger.error({ file: f, err }, 'context db: migration failed');
      throw err;
    }
  }
}

function ensureColumn(sqlite: DatabaseSync, table: string, column: string, ddl: string): void {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  if (!tableExists) return;
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  pinoLogger.info({ table, column }, 'context db: column added');
}

function ensureRuntimeSchema(sqlite: DatabaseSync): void {
  ensureColumn(sqlite, 'agent_runtime_sessions', 'active_run_id', 'active_run_id TEXT');
  ensureColumn(sqlite, 'agent_runtime_sessions', 'pending_resume_token', 'pending_resume_token TEXT');
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
  ensureColumn(sqlite, 'wiki_source_bindings', 'file_path', 'file_path TEXT');
  ensureColumn(sqlite, 'wiki_source_bindings', 'start_line', 'start_line INTEGER');
  ensureColumn(sqlite, 'wiki_source_bindings', 'end_line', 'end_line INTEGER');
  ensureColumn(sqlite, 'wiki_source_bindings', 'qualified_name', 'qualified_name TEXT');
}

export function getDb(): ContextDb {
  if (_db && _sqlite) return _db;

  const dbPath = resolveDbPath();
  const sqlite = installSqliteCompat(new DatabaseSync(dbPath));
  configureSqlite(sqlite);

  runMigrations(sqlite);
  ensureRuntimeSchema(sqlite);

  _sqlite = sqlite;
  _db = drizzle({ client: sqlite, schema });
  pinoLogger.info({ dbPath }, 'context db: ready');
  return _db;
}

export function getRawSqlite(): RawSqlite {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export function closeDb(): void {
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch {
      /* noop */
    }
    _sqlite = null;
    _db = null;
  }
}

export { schema };
