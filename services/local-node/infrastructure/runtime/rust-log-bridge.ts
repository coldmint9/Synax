import { StringDecoder } from 'node:string_decoder';
import { ingestRuntimeLog } from './logger.js';
import type { ApiLogLevel } from './log-store.js';

const MAX_LINE_CHARS = 64 * 1024;
const levels = new Set<ApiLogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
type Entry = Parameters<typeof ingestRuntimeLog>[0];
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A bounded NDJSON decoder: pipes can split UTF-8 and lines at any byte. */
export function createRustLogBridge(
  identity: { sidecarPid?: number; generation: number },
  emit: (entry: Entry) => void = ingestRuntimeLog,
) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discarding = false;
  let ended = false;
  const base = { source: 'rust-runtime', ...identity };
  function line(raw: string) {
    if (!raw.trim()) return;
    let record: Record<string, unknown> | undefined;
    try { record = object(JSON.parse(raw)); } catch { /* legacy stderr */ }
    const level = String(record?.level ?? '').toLowerCase() as ApiLogLevel;
    const fields = object(record?.fields);
    if (record && levels.has(level) && fields && typeof fields.message === 'string') {
      const { message, pid: _nativePid, ...details } = fields;
      const spans = Array.isArray(record.spans) ? record.spans.filter(item => object(item)) : [];
      const timestamp = typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))
        ? record.timestamp : undefined;
      emit({ level, message, loggedAt: timestamp, context: {
        // Pino owns `pid`; keep the native PID in spans and trusted sidecarPid.
        ...Object.assign({}, ...spans.map(span => { const { name: _name, pid: _pid, ...values } = span; return values; })),
        ...details, target: record.target, spans, ...base,
      } });
    } else {
      emit({ level: 'warn', message: '[runtime-sidecar] unstructured stderr', context: { ...base, output: raw } });
    }
  }
  function consume(text: string) {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      if (!discarding) {
        if (pending.length + end - start > MAX_LINE_CHARS) {
          pending = ''; discarding = true;
          emit({ level: 'warn', message: 'Runtime log line exceeded the size limit', context: { ...base, event: 'logging.line_dropped', limit: MAX_LINE_CHARS } });
        } else pending += text.slice(start, end);
      }
      if (newline < 0) break;
      if (!discarding) line(pending.replace(/\r$/, ''));
      pending = ''; discarding = false; start = newline + 1;
    }
  }
  return {
    write(chunk: Buffer) { if (!ended) consume(decoder.write(chunk)); },
    end() {
      if (ended) return;
      consume(decoder.end());
      if (!discarding) line(pending);
      pending = ''; ended = true;
    },
  };
}
