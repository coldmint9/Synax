import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  purgeProject: vi.fn(async () => undefined),
  publishLatestWikiSnapshot: vi.fn(async () => undefined),
  generate: vi.fn(async () => ({ snapshotId: 'snap-new' })),
  notify: vi.fn(),
}));

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    purgeProject: mocks.purgeProject,
  },
}));

vi.mock('../wiki-snapshot-events.js', () => ({
  publishLatestWikiSnapshot: mocks.publishLatestWikiSnapshot,
  WikiSnapshotEventReason: { ProjectPurged: 'project_purged' },
}));

vi.mock('../wiki-loop-service.js', () => ({
  wikiLoopService: {
    generate: mocks.generate,
  },
}));

vi.mock('../../notifications/notify.js', () => ({
  notify: mocks.notify,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { _clearReinitializeLocksForTests } from '../wiki-project-locks.js';
import { queueReinitialize } from '../wiki-reinitialize-service.js';

describe('queueReinitialize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearReinitializeLocksForTests();
  });

  it('returns false when reinitialize is already queued for the project', () => {
    expect(queueReinitialize({ projectId: 'p1', workDir: '/tmp/repo' })).toBe(true);
    expect(queueReinitialize({ projectId: 'p1', workDir: '/tmp/repo' })).toBe(false);
  });

  it('runs purge, snapshot publish, and generate in the background', async () => {
    expect(queueReinitialize({ projectId: 'p2', workDir: '/tmp/repo', locale: 'en' })).toBe(true);

    await vi.waitFor(() => {
      expect(mocks.purgeProject).toHaveBeenCalledWith('p2');
      expect(mocks.publishLatestWikiSnapshot).toHaveBeenCalledWith('p2', 'project_purged');
      expect(mocks.generate).toHaveBeenCalledWith({
        projectId: 'p2',
        workDir: '/tmp/repo',
        locale: 'en',
      });
    });
  });

  it('notifies task_failed when background work throws', async () => {
    mocks.purgeProject.mockRejectedValueOnce(new Error('purge failed'));

    expect(queueReinitialize({ projectId: 'p3', workDir: '/tmp/repo' })).toBe(true);

    await vi.waitFor(() => {
      expect(mocks.notify).toHaveBeenCalled();
    });
  });
});
