import { afterEach, expect, it, vi } from 'vitest';
import { formatLogTimestamp } from '../log-retention.js';
import { persistApiLog, listApiLogs } from '../log-store.js';

afterEach(() => vi.unstubAllEnvs());

it('formats local time and includes the offset without changing the instant', () => {
  vi.stubEnv('TZ', 'Asia/Shanghai');
  const instant = new Date('2026-10-21T07:26:36.669Z');
  const text = formatLogTimestamp(instant);
  expect(text).toBe('2026-10-21T15:26:36.669+08:00');
  expect(Date.parse(text)).toBe(instant.getTime());
  expect(formatLogTimestamp(new Date('2026-10-21T16:00:00Z'))).toBe('2026-10-22T00:00:00.000+08:00');
});

it('uses the offset at the event time across daylight-saving transitions', () => {
  vi.stubEnv('TZ', 'America/New_York');
  expect(formatLogTimestamp(new Date('2026-03-08T06:59:59Z'))).toBe('2026-03-08T01:59:59.000-05:00');
  expect(formatLogTimestamp(new Date('2026-03-08T07:00:00Z'))).toBe('2026-03-08T03:00:00.000-04:00');
});

it('writes new Node log entries with local timestamps and preserves supplied native offsets', async () => {
  vi.stubEnv('TZ', 'Asia/Shanghai');
  const message = `log-timezone-${crypto.randomUUID()}`;
  persistApiLog({ level: 'info', message, context: {} });
  const row = (await listApiLogs()).find(row => row.message === message)!;
  expect(row.loggedAt).toMatch(/\+08:00$/);
  expect(row.day).toBe(row.loggedAt.slice(0, 10));
  const timestamp = `${row.day}T00:00:00.123456+08:00`;
  persistApiLog({ level: 'warn', message: `${message}-native`, context: {}, loggedAt: timestamp });
  expect((await listApiLogs()).find(row => row.message === `${message}-native`)!.loggedAt).toBe(timestamp);
});
