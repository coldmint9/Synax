import { beforeEach, describe, expect, it } from 'vitest';
import { formatLocalDay, LOG_RETENTION_DAYS, retentionCutoffDay } from '../log-retention.js';

describe('log-store retention', () => {
  beforeEach(async () => {
    const { clearApiLogStoreForTests } = await import('../log-store.js');
    clearApiLogStoreForTests();
  });

  it('drops sqlite log rows older than the retention window', async () => {
    const { clearApiLogStoreForTests, listApiLogs, persistApiLog, pruneOldApiLogs } = await import('../log-store.js');

    const cutoff = retentionCutoffDay(LOG_RETENTION_DAYS);
    const expiredDay = new Date(`${cutoff}T00:00:00`);
    expiredDay.setDate(expiredDay.getDate() - 1);
    const expired = formatLocalDay(expiredDay);

    persistApiLog({
      level: 'info',
      message: 'fresh',
      context: {},
    });
    persistApiLog({
      level: 'warn',
      message: 'stale',
      context: {},
      loggedAt: `${expired}T12:00:00.000Z`,
    });

    expect(listApiLogs({ limit: 10 })).toHaveLength(2);

    pruneOldApiLogs();

    expect(listApiLogs({ limit: 10 })).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'fresh',
      }),
    ]);

    clearApiLogStoreForTests();
  });
});
