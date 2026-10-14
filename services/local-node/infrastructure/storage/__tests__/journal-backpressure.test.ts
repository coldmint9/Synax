import { afterEach, expect, it, vi } from 'vitest';
import { JournalWriter } from '../../../modules/agent-runtime/journal-writer.js';
import { runtimeJournal } from '../../../modules/agent-runtime/runtime-journal.js';
import { MAX_PENDING_JOURNAL_COMMITS } from '../../database/write-contention.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('waits for file-journal capacity instead of failing another session', async () => {
  vi.stubEnv('SYNAX_STORAGE_OWNER_ENDPOINT', 'test-only-no-connection');
  const releases: Array<() => void> = [];
  const persist = vi.spyOn(runtimeJournal, 'appendDurable').mockImplementation(() => new Promise<void>(resolve => releases.push(resolve)));
  const writer = new JournalWriter();
  const writes = Array.from({ length: MAX_PENDING_JOURNAL_COMMITS + 1 }, (_, n) => writer.append(`s${n}`, `r${n}`, [{ type: 'done', sessionId: `s${n}`, runId: `r${n}` }], 0));
  try {
    expect(persist).toHaveBeenCalledTimes(MAX_PENDING_JOURNAL_COMMITS);
    releases.shift()!();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(MAX_PENDING_JOURNAL_COMMITS + 1));
    for (const release of releases.splice(0)) release();
    await Promise.all(writes);
  } finally {
    for (const release of releases) release();
    await writer.close();
  }
});
