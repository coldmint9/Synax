import { describe, expect, it, vi } from 'vitest';
import { createRustLogBridge } from './rust-log-bridge.js';
import { ingestRuntimeLog } from './logger.js';
import { listApiLogs } from './log-store.js';

const native = (level = 'ERROR', message = '请求失败') => JSON.stringify({
  timestamp: '2026-10-21T09:02:03.456789+08:00', level, target: 'synax_runtime_sidecar::llm',
  fields: { message, event: 'provider.failed', status_code: 429 },
  spans: [{ name: 'runtime', pid: 123 }, { name: 'agent_loop', session_id: 's1', run_id: 'r1' },
    { name: 'provider', provider_request_id: 'p1' }],
});

describe('Rust structured log ingress', () => {
  it('preserves levels, timestamps and correlation across every possible UTF-8 split', () => {
    const bytes = Buffer.from(`${native()}\n`);
    for (let split = 0; split <= bytes.length; split++) {
      const emit = vi.fn();
      const bridge = createRustLogBridge({ sidecarPid: 123, generation: 2 }, emit);
      bridge.write(bytes.subarray(0, split)); bridge.write(bytes.subarray(split)); bridge.end();
      expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        level: 'error', message: '请求失败', loggedAt: '2026-10-21T09:02:03.456789+08:00',
        context: expect.objectContaining({ source: 'rust-runtime', sidecarPid: 123, generation: 2,
          session_id: 's1', run_id: 'r1', provider_request_id: 'p1', status_code: 429 }),
      }));
      expect(emit.mock.calls[0][0].context.pid).toBeUndefined();
      expect(emit.mock.calls[0][0].context.spans[0].pid).toBe(123);
    }
  });

  it('handles all levels, CRLF, multiple lines and a final unterminated line exactly once', () => {
    const emit = vi.fn();
    const bridge = createRustLogBridge({ generation: 1 }, emit);
    bridge.write(Buffer.from(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].map(level => native(level)).join('\r\n')));
    bridge.end(); bridge.end(); bridge.write(Buffer.from(native()));
    expect(emit.mock.calls.map(([row]) => row.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('retains legacy and malformed stderr at warn instead of dropping errors at debug', () => {
    const emit = vi.fn();
    const bridge = createRustLogBridge({ generation: 1 }, emit);
    bridge.write(Buffer.from('fatal: failed\n{"level":"ERROR"}\n\n'));
    bridge.end();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.every(([row]) => row.level === 'warn')).toBe(true);
  });

  it('bounds incomplete lines and recovers at the next newline', () => {
    const emit = vi.fn();
    const bridge = createRustLogBridge({ generation: 1 }, emit);
    for (let i = 0; i < 30; i++) bridge.write(Buffer.alloc(8192, 120));
    bridge.write(Buffer.from(`\n${native('INFO')}\n`)); bridge.end();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][0].context.event).toBe('logging.line_dropped');
    expect(emit.mock.calls[1][0].level).toBe('info');
  });

  it('does not allow native fields to replace trusted source and process identity', () => {
    const emit = vi.fn();
    const bridge = createRustLogBridge({ sidecarPid: 5, generation: 3 }, emit);
    bridge.write(Buffer.from(JSON.stringify({ level: 'WARN', timestamp: 'invalid',
      fields: { message: 'test', source: 'spoof', sidecarPid: 999, generation: 99 } })));
    bridge.end();
    expect(emit.mock.calls[0][0]).toMatchObject({ loggedAt: undefined,
      context: { source: 'rust-runtime', sidecarPid: 5, generation: 3 } });
  });

  it('persists native debug logs even when the Node logger defaults to info', async () => {
    const marker = `native-debug-${crypto.randomUUID()}`;
    ingestRuntimeLog({ level: 'debug', message: marker, loggedAt: new Date().toISOString(),
      context: { source: 'rust-runtime', provider_request_id: 'correlated' } });
    const rows = await listApiLogs();
    expect(rows.find(row => row.message === marker)).toMatchObject({ level: 'debug',
      context: { source: 'rust-runtime', provider_request_id: 'correlated' } });
  });
});
