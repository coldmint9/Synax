import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { DATA_ROOT, LOG_LEVEL, isDev } from './env.js';
import { persistApiLog, type ApiLogLevel } from './log-store.js';

/** 检查 pino-pretty 是否可用 */
function hasPinoPretty(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const rawLogger = pino({
  level: LOG_LEVEL,
  ...(isDev && hasPinoPretty() && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

function resolveSessionLogFilePath(): string {
  const dataRoot = path.isAbsolute(DATA_ROOT)
    ? DATA_ROOT
    : path.resolve(process.cwd(), DATA_ROOT);
  const logDir = path.join(dataRoot, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return path.join(logDir, 'api-current.log');
}

export const API_SESSION_LOG_FILE = resolveSessionLogFilePath();

function initSessionLogFile(): void {
  fs.writeFileSync(API_SESSION_LOG_FILE, '', 'utf8');
}

function writeSessionLogLine(line: string): void {
  fs.appendFileSync(API_SESSION_LOG_FILE, `${line}\n`, 'utf8');
}

export interface AppLogger {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
}

function normalizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => normalizeValue(item, seen));
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normalizeValue(child, seen);
  }
  seen.delete(value);
  return out;
}

function toContext(value: unknown): Record<string, unknown> {
  const normalized = normalizeValue(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return {};
  }
  return normalized as Record<string, unknown>;
}

function normalizeLogCall(args: unknown[]): { message: string; context: Record<string, unknown> } {
  const [first, second, ...rest] = args;
  const extraArgs = rest.map((item) => normalizeValue(item));
  let message = '';
  let context: Record<string, unknown> = {};

  if (typeof first === 'string') {
    message = first;
    if (second !== undefined) {
      context = second instanceof Error ? { err: normalizeValue(second) } : toContext(second);
    }
  } else if (first instanceof Error) {
    context = { err: normalizeValue(first) };
    message = typeof second === 'string' ? second : first.message;
  } else if (first && typeof first === 'object') {
    context = toContext(first);
    if (typeof second === 'string') {
      message = second;
    } else if (typeof context.msg === 'string') {
      message = context.msg;
    }
  } else if (first !== undefined) {
    message = String(first);
  }

  if (extraArgs.length > 0) {
    context.extraArgs = extraArgs;
  }
  if (!message && typeof second === 'string') {
    message = second;
  }

  return { message, context };
}

function formatSessionLogLine(level: ApiLogLevel, message: string, context: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const suffix = Object.keys(context).length > 0
    ? ` ${JSON.stringify(context)}`
    : '';
  return `${timestamp} ${level.toUpperCase()} ${message || '-'}${suffix}`;
}

function fallbackWrite(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* noop */
  }
}

try {
  initSessionLogFile();
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  fallbackWrite(`[api-logger] failed to initialize session log file: ${message}`);
}

function emit(level: ApiLogLevel, args: unknown[]): void {
  if (!rawLogger.isLevelEnabled(level)) return;
  const entry = normalizeLogCall(args);
  try {
    writeSessionLogLine(formatSessionLogLine(level, entry.message, entry.context));
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    fallbackWrite(`[api-logger] failed to write session log file: ${message}`);
  }
  persistApiLog({
    level,
    message: entry.message,
    context: entry.context,
  });
  (rawLogger[level] as (...input: unknown[]) => void).apply(rawLogger, args);
}

/** 应用日志实例 */
export const logger: AppLogger = {
  trace: (...args) => emit('trace', args),
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
  fatal: (...args) => emit('fatal', args),
};
