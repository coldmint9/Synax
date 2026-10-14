import { afterEach, describe, expect, it } from 'vitest';
import {
  JOURNAL_COMMIT_DEADLINE_MS,
  isWriteContentionError,
  journalWriteLockBudgetMs,
  journalWriteLockPolicy,
  retryWriteLockAcquisition,
  sleepSync,
  type WriteLockPolicy,
} from '../write-contention.js';

const original = process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
afterEach(() => {
  if (original === undefined) delete process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
  else process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = original;
});

/** libsql surfaces SQLITE_BUSY as `SqliteError` with both fields populated. */
const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', rawCode: 5 });
const policy = (over: Partial<WriteLockPolicy> = {}): WriteLockPolicy =>
  ({ waitMs: 10, attempts: 3, backoffMs: 0, ...over });

describe('write contention classification', () => {
  it('recognises result codes and message text', () => {
    expect(isWriteContentionError(busy())).toBe(true);
    expect(isWriteContentionError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isWriteContentionError(new Error('database schema is locked'))).toBe(true);
    expect(isWriteContentionError(new Error('database table is locked'))).toBe(true);
  });

  it('leaves unrelated failures alone', () => {
    expect(isWriteContentionError(new Error('Obsolete conversation execution.'))).toBe(false);
    expect(isWriteContentionError(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }))).toBe(false);
    expect(isWriteContentionError(undefined)).toBe(false);
    expect(isWriteContentionError('database is locked')).toBe(false);
  });
});

describe('journal write lock policy', () => {
  it('keeps the whole budget under the commit acknowledgement deadline', () => {
    delete process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS;
    expect(journalWriteLockBudgetMs()).toBeLessThan(JOURNAL_COMMIT_DEADLINE_MS);
    expect(journalWriteLockPolicy().waitMs).toBeGreaterThan(1_000);
  });

  it('honours a request and clamps an oversized one', () => {
    process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = '800';
    expect(journalWriteLockPolicy().waitMs).toBe(800);
    process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = '600000';
    expect(journalWriteLockBudgetMs()).toBeLessThan(JOURNAL_COMMIT_DEADLINE_MS);
  });

  it('falls back to the default for unusable values', () => {
    for (const value of ['', '   ', 'soon', '-5']) {
      process.env.SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS = value;
      expect(journalWriteLockPolicy().waitMs).toBeGreaterThan(1_000);
    }
  });
});

describe('lock acquisition retry', () => {
  it('retries a contended acquisition and returns the value', () => {
    let attempts = 0;
    const value = retryWriteLockAcquisition(policy(), () => {
      if (++attempts < 3) throw busy();
      return 'committed';
    }, () => false);
    expect(value).toBe('committed');
    expect(attempts).toBe(3);
  });

  it('reports the last failure once attempts are exhausted', () => {
    let attempts = 0;
    expect(() => retryWriteLockAcquisition(policy(), () => { attempts++; throw busy(); }, () => false))
      .toThrow(/locked/);
    expect(attempts).toBe(3);
  });

  it('never replays an attempt that already wrote', () => {
    let attempts = 0;
    let wrote = false;
    expect(() => retryWriteLockAcquisition(policy(), () => {
      attempts++;
      wrote = true;
      throw busy();
    }, () => wrote)).toThrow(/locked/);
    expect(attempts).toBe(1);
  });

  it('does not retry a failure that is not lock contention', () => {
    let attempts = 0;
    expect(() => retryWriteLockAcquisition(policy(), () => {
      attempts++;
      throw new Error('Obsolete conversation execution.');
    }, () => false)).toThrow(/Obsolete/);
    expect(attempts).toBe(1);
  });

  it('blocks without yielding the thread', () => {
    const startedAt = Date.now();
    sleepSync(60);
    sleepSync(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});
