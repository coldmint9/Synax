import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './env.js';
import { formatLocalDay, LOG_RETENTION_DAYS, retentionCutoffDay } from './log-retention.js';

const DAILY_LOG_PREFIX = 'api-';
const DAILY_LOG_SUFFIX = '.log';
const LEGACY_LOG_FILE = 'api-current.log';

let trackedDay: string | null = null;

export function resolveLogDir(): string {
  const dataRoot = path.isAbsolute(DATA_ROOT)
    ? DATA_ROOT
    : path.resolve(process.cwd(), DATA_ROOT);
  const logDir = path.join(dataRoot, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

export function resolveDailyLogFilePath(day = formatLocalDay(new Date())): string {
  return path.join(resolveLogDir(), `${DAILY_LOG_PREFIX}${day}${DAILY_LOG_SUFFIX}`);
}

export function getApiLogFilePath(): string {
  return resolveDailyLogFilePath();
}

/** 当日日志文件路径 */
export const API_SESSION_LOG_FILE = getApiLogFilePath();

export function pruneOldDailyLogFiles(retentionDays = LOG_RETENTION_DAYS): void {
  const cutoff = retentionCutoffDay(retentionDays);
  const logDir = resolveLogDir();
  for (const entry of fs.readdirSync(logDir)) {
    const match = /^api-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry);
    if (match && match[1] < cutoff) {
      fs.unlinkSync(path.join(logDir, entry));
      continue;
    }
    if (entry === LEGACY_LOG_FILE) {
      fs.unlinkSync(path.join(logDir, entry));
    }
  }
}

export function initDailyLogFiles(): void {
  pruneOldDailyLogFiles();
  trackedDay = formatLocalDay(new Date());
}

export function writeDailyLogLine(line: string): void {
  const today = formatLocalDay(new Date());
  if (trackedDay !== today) {
    trackedDay = today;
    pruneOldDailyLogFiles();
  }
  fs.appendFileSync(resolveDailyLogFilePath(today), `${line}\n`, 'utf8');
}

export function clearDailyLogFilesForTests(): void {
  const logDir = resolveLogDir();
  if (!fs.existsSync(logDir)) return;
  for (const entry of fs.readdirSync(logDir)) {
    if (entry.startsWith(DAILY_LOG_PREFIX) || entry === LEGACY_LOG_FILE) {
      fs.unlinkSync(path.join(logDir, entry));
    }
  }
  trackedDay = null;
}
