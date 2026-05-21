import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './env.js';

export type ApiLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface PersistApiLogInput {
  level: ApiLogLevel;
  message: string;
  context: Record<string, unknown>;
  loggedAt?: string;
}

export interface ApiLogEntry {
  id: number;
  day: string;
  loggedAt: string;
  level: ApiLogLevel;
  message: string;
  context: Record<string, unknown>;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
}

export interface ApiLogDailyStat {
  day: string;
  totalCount: number;
  traceCount: number;
  debugCount: number;
  infoCount: number;
  warnCount: number;
  errorCount: number;
  fatalCount: number;
  requestCount: number;
  errorRequestCount: number;
  lastLoggedAt: string | null;
}

interface PersistedLogRow {
  day: string;
  loggedAt: string;
  level: ApiLogLevel;
  message: string;
  contextJson: string;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  traceCount: number;
  debugCount: number;
  infoCount: number;
  warnCount: number;
  errorCount: number;
  fatalCount: number;
  requestCount: number;
  errorRequestCount: number;
}

let sqlite: DatabaseSync | null = null;
let insertLogStmt: ReturnType<DatabaseSync['prepare']> | null = null;
let upsertDailyStatsStmt: ReturnType<DatabaseSync['prepare']> | null = null;

function resolveDataRootDir(): string {
  const dir = path.isAbsolute(DATA_ROOT)
    ? DATA_ROOT
    : path.resolve(process.cwd(), DATA_ROOT);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resolveLogDbPath(): string {
  return path.join(resolveDataRootDir(), 'api-logs.db');
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      method TEXT,
      path TEXT,
      status INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_logs_day ON api_logs(day);
    CREATE INDEX IF NOT EXISTS idx_api_logs_logged_at ON api_logs(logged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_logs_level ON api_logs(level);

    CREATE TABLE IF NOT EXISTS api_log_daily_stats (
      day TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL DEFAULT 0,
      trace_count INTEGER NOT NULL DEFAULT 0,
      debug_count INTEGER NOT NULL DEFAULT 0,
      info_count INTEGER NOT NULL DEFAULT 0,
      warn_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      fatal_count INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      error_request_count INTEGER NOT NULL DEFAULT 0,
      last_logged_at TEXT
    );
  `);
}

function getLogDb(): DatabaseSync {
  if (sqlite) return sqlite;

  const db = new DatabaseSync(resolveLogDbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  ensureSchema(db);

  insertLogStmt = db.prepare(`
    INSERT INTO api_logs (
      day,
      logged_at,
      level,
      message,
      context_json,
      method,
      path,
      status,
      duration_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  upsertDailyStatsStmt = db.prepare(`
    INSERT INTO api_log_daily_stats (
      day,
      total_count,
      trace_count,
      debug_count,
      info_count,
      warn_count,
      error_count,
      fatal_count,
      request_count,
      error_request_count,
      last_logged_at
    )
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      total_count = total_count + 1,
      trace_count = trace_count + excluded.trace_count,
      debug_count = debug_count + excluded.debug_count,
      info_count = info_count + excluded.info_count,
      warn_count = warn_count + excluded.warn_count,
      error_count = error_count + excluded.error_count,
      fatal_count = fatal_count + excluded.fatal_count,
      request_count = request_count + excluded.request_count,
      error_request_count = error_request_count + excluded.error_request_count,
      last_logged_at = CASE
        WHEN api_log_daily_stats.last_logged_at IS NULL THEN excluded.last_logged_at
        WHEN excluded.last_logged_at > api_log_daily_stats.last_logged_at THEN excluded.last_logged_at
        ELSE api_log_daily_stats.last_logged_at
      END
  `);

  sqlite = db;
  return db;
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function toPersistedRow(input: PersistApiLogInput): PersistedLogRow {
  const loggedAt = input.loggedAt ?? new Date().toISOString();
  const loggedDate = new Date(loggedAt);
  const context = input.context ?? {};
  const method = typeof context.method === 'string' ? context.method : null;
  const requestPath = typeof context.path === 'string' ? context.path : null;
  const status = coerceInt(context.status);
  const durationMs = coerceInt(context.ms ?? context.durationMs);
  const isRequest = Boolean(method && requestPath);
  const isErrorRequest = isRequest && status !== null && status >= 500;

  return {
    day: formatLocalDay(loggedDate),
    loggedAt,
    level: input.level,
    message: input.message,
    contextJson: JSON.stringify(context),
    method,
    path: requestPath,
    status,
    durationMs,
    traceCount: input.level === 'trace' ? 1 : 0,
    debugCount: input.level === 'debug' ? 1 : 0,
    infoCount: input.level === 'info' ? 1 : 0,
    warnCount: input.level === 'warn' ? 1 : 0,
    errorCount: input.level === 'error' ? 1 : 0,
    fatalCount: input.level === 'fatal' ? 1 : 0,
    requestCount: isRequest ? 1 : 0,
    errorRequestCount: isErrorRequest ? 1 : 0,
  };
}

function fallbackWrite(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* noop */
  }
}

export function persistApiLog(input: PersistApiLogInput): void {
  try {
    const db = getLogDb();
    const row = toPersistedRow(input);
    db.exec('BEGIN');
    try {
      insertLogStmt!.run(
        row.day,
        row.loggedAt,
        row.level,
        row.message,
        row.contextJson,
        row.method,
        row.path,
        row.status,
        row.durationMs,
      );
      upsertDailyStatsStmt!.run(
        row.day,
        row.traceCount,
        row.debugCount,
        row.infoCount,
        row.warnCount,
        row.errorCount,
        row.fatalCount,
        row.requestCount,
        row.errorRequestCount,
        row.loggedAt,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    fallbackWrite(`[api-log-store] failed to persist log: ${message}`);
  }
}

export function listApiLogDailyStats(days = 30): ApiLogDailyStat[] {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));
  const db = getLogDb();
  const rows = db.prepare(`
    SELECT
      day,
      total_count AS totalCount,
      trace_count AS traceCount,
      debug_count AS debugCount,
      info_count AS infoCount,
      warn_count AS warnCount,
      error_count AS errorCount,
      fatal_count AS fatalCount,
      request_count AS requestCount,
      error_request_count AS errorRequestCount,
      last_logged_at AS lastLoggedAt
    FROM api_log_daily_stats
    ORDER BY day DESC
    LIMIT ?
  `).all(safeDays) as unknown as ApiLogDailyStat[];

  return rows;
}

export function listApiLogs(input?: {
  day?: string;
  limit?: number;
}): ApiLogEntry[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(input?.limit ?? 100)));
  const db = getLogDb();
  const rows = input?.day
    ? db.prepare(`
        SELECT
          id,
          day,
          logged_at AS loggedAt,
          level,
          message,
          context_json AS contextJson,
          method,
          path,
          status,
          duration_ms AS durationMs
        FROM api_logs
        WHERE day = ?
        ORDER BY logged_at DESC, id DESC
        LIMIT ?
      `).all(input.day, limit)
    : db.prepare(`
        SELECT
          id,
          day,
          logged_at AS loggedAt,
          level,
          message,
          context_json AS contextJson,
          method,
          path,
          status,
          duration_ms AS durationMs
        FROM api_logs
        ORDER BY logged_at DESC, id DESC
        LIMIT ?
      `).all(limit);

  return (rows as unknown as Array<{
    id: number;
    day: string;
    loggedAt: string;
    level: ApiLogLevel;
    message: string;
    contextJson: string;
    method: string | null;
    path: string | null;
    status: number | null;
    durationMs: number | null;
  }>).map((row) => ({
    id: row.id,
    day: row.day,
    loggedAt: row.loggedAt,
    level: row.level,
    message: row.message,
    context: JSON.parse(row.contextJson) as Record<string, unknown>,
    method: row.method,
    path: row.path,
    status: row.status,
    durationMs: row.durationMs,
  }));
}

export function clearApiLogStoreForTests(): void {
  const db = getLogDb();
  db.exec(`
    DELETE FROM api_logs;
    DELETE FROM api_log_daily_stats;
  `);
}

export function closeApiLogStore(): void {
  if (!sqlite) return;
  sqlite.close();
  sqlite = null;
  insertLogStmt = null;
  upsertDailyStatsStmt = null;
}
