import { Writable } from 'node:stream';
import pino from 'pino';
import { NODE_ENV } from './env.js';

export type LogLevelLabel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_COLORS: Record<LogLevelLabel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[91m\x1b[1m',
  fatal: '\x1b[41m\x1b[97m\x1b[1m',
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const LEVEL_WIDTH = 5;

/** 是否向终端输出彩色日志（尊重 NO_COLOR / FORCE_COLOR） */
export function shouldColorizeLogs(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (NODE_ENV === 'test') return false;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatContext(bindings: Record<string, unknown>): string {
  const rest = { ...bindings };
  delete rest.level;
  delete rest.time;
  delete rest.pid;
  delete rest.hostname;
  delete rest.msg;
  delete rest.v;
  if (Object.keys(rest).length === 0) return '';
  return ` ${DIM}${JSON.stringify(rest)}${RESET}`;
}

function resolveLevelLabel(bindings: Record<string, unknown>): LogLevelLabel {
  const levelNum = typeof bindings.level === 'number' ? bindings.level : 30;
  const label = pino.levels.labels[levelNum] ?? 'info';
  if (label === 'trace' || label === 'debug' || label === 'info' || label === 'warn' || label === 'error' || label === 'fatal') {
    return label;
  }
  return 'info';
}

/** 将 pino JSON 行格式化为带 ANSI 颜色的终端输出 */
export function formatPrettyLogLine(bindings: Record<string, unknown>): string {
  const label = resolveLevelLabel(bindings);
  const color = LEVEL_COLORS[label];
  const time = typeof bindings.time === 'number' ? formatTimestamp(bindings.time) : '';
  const message = typeof bindings.msg === 'string' ? bindings.msg : '';
  const levelTag = label.toUpperCase().padEnd(LEVEL_WIDTH);
  const context = formatContext(bindings);
  return `${DIM}${time}${RESET} ${color}${levelTag}${RESET} ${message}${context}\n`;
}

/** 内置 ANSI 彩色输出流（不依赖 pino-pretty） */
export function createColorizedLogStream(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          process.stdout.write(formatPrettyLogLine(parsed));
        } catch {
          process.stdout.write(`${line}\n`);
        }
      }
      callback();
    },
  });
}

/** 检查 pino-pretty 是否可用 */
export function hasPinoPretty(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** pino-pretty 配置：按级别着色，error / info 对比明显 */
export function buildPinoPrettyOptions(): Record<string, unknown> {
  return {
    colorize: true,
    levelFirst: true,
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: false,
    customColors: 'trace:gray,debug:cyan,info:green,warn:yellow,error:redBright,fatal:bgRed',
  };
}
