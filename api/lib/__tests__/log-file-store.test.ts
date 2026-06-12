import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLocalDay, LOG_RETENTION_DAYS, retentionCutoffDay } from '../log-retention.js';

describe('log-file-store', () => {
  beforeEach(async () => {
    const { clearDailyLogFilesForTests } = await import('../log-file-store.js');
    clearDailyLogFilesForTests();
  });

  afterEach(async () => {
    const { clearDailyLogFilesForTests } = await import('../log-file-store.js');
    clearDailyLogFilesForTests();
  });

  it('writes logs to a daily file named by local date', async () => {
    const { getApiLogFilePath, writeDailyLogLine } = await import('../log-file-store.js');
    const today = formatLocalDay(new Date());

    writeDailyLogLine('INFO hello');

    expect(getApiLogFilePath()).toBe(path.join(path.dirname(getApiLogFilePath()), `api-${today}.log`));
    expect(fs.readFileSync(getApiLogFilePath(), 'utf8')).toContain('INFO hello');
  });

  it('removes daily log files older than the retention window', async () => {
    const {
      pruneOldDailyLogFiles,
      resolveDailyLogFilePath,
      resolveLogDir,
      writeDailyLogLine,
    } = await import('../log-file-store.js');

    const cutoff = retentionCutoffDay(LOG_RETENTION_DAYS);
    const expiredDay = new Date(`${cutoff}T00:00:00`);
    expiredDay.setDate(expiredDay.getDate() - 1);
    const expired = formatLocalDay(expiredDay);

    fs.writeFileSync(resolveDailyLogFilePath(expired), 'stale\n', 'utf8');
    writeDailyLogLine('INFO fresh');

    pruneOldDailyLogFiles();

    expect(fs.existsSync(resolveDailyLogFilePath(expired))).toBe(false);
    expect(fs.readdirSync(resolveLogDir()).some((name) => name === `api-${formatLocalDay(new Date())}.log`)).toBe(true);
  });
});
