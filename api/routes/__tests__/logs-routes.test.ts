import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

describe('log routes', () => {
  beforeEach(async () => {
    const { clearApiLogStoreForTests } = await import('../../lib/log-store.js');
    const { clearDailyLogFilesForTests } = await import('../../lib/log-file-store.js');
    clearApiLogStoreForTests();
    clearDailyLogFilesForTests();
  });

  it('persists logs and exposes daily stats', async () => {
    const { logger } = await import('../../lib/logger.js');
    logger.info({ method: 'GET', path: '/api/health', status: 200, ms: 12 }, 'request');
    logger.error({ method: 'POST', path: '/api/projects', status: 503, ms: 5, err: 'boom' }, 'request');
    logger.warn({ feature: 'wiki-refresh' }, 'degraded');

    const { logRoutes } = await import('../logs.js');

    const statsRes = await logRoutes.request('http://localhost/stats/daily?days=7');
    const statsBody = await statsRes.json();

    expect(statsRes.status).toBe(200);
    expect(statsBody.items).toHaveLength(1);
    expect(statsBody.items[0]).toEqual(
      expect.objectContaining({
        totalCount: 3,
        infoCount: 1,
        warnCount: 1,
        errorCount: 1,
        requestCount: 2,
        errorRequestCount: 1,
      }),
    );

    const listRes = await logRoutes.request('http://localhost/?limit=10');
    const listBody = await listRes.json();

    expect(listRes.status).toBe(200);
    expect(listBody.items).toHaveLength(3);
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          message: 'request',
          method: 'GET',
          path: '/api/health',
          status: 200,
          durationMs: 12,
        }),
        expect.objectContaining({
          level: 'warn',
          message: 'degraded',
          context: expect.objectContaining({ feature: 'wiki-refresh' }),
        }),
      ]),
    );
  });

  it('rejects invalid day filters', async () => {
    const { logRoutes } = await import('../logs.js');
    const res = await logRoutes.request('http://localhost/?day=today');

    expect(res.status).toBe(400);
  });

  it('writes the current daily log file', async () => {
    const { getApiLogFilePath, logger } = await import('../../lib/logger.js');
    logger.info({ method: 'GET', path: '/api/health', status: 200, ms: 9 }, 'request');

    const text = fs.readFileSync(getApiLogFilePath(), 'utf8');

    expect(text).toContain('INFO request');
    expect(text).toContain('"path":"/api/health"');
    expect(text).toContain('"status":200');
  });
});
