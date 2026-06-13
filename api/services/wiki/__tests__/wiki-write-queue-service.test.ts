import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { wikiWriteBatches, wikiWriteQueueItems } from '../../../db/schema.js';

vi.mock('../../llm-runtime/middleware/rate-limiter.js', () => ({
  isSaturated: () => false,
}));

vi.mock('../wiki-document-processor.js', () => ({
  loadScanForBatch: vi.fn(async () => ({ scan: { codeIndex: { files: [] } } })),
  loadOutlineForSnapshot: vi.fn(async (snapshotId: string) => ({
    outline: snapshotId === 'snap-test-1'
      ? [
          { id: 'doc-1', nodeKind: 'document', docType: 'module', title: 'Architecture', sortOrder: 0, targetFiles: [], keyQuestions: [] },
          { id: 'doc-2', nodeKind: 'document', docType: 'module', title: 'Modules', sortOrder: 1, targetFiles: [], keyQuestions: [] },
        ]
      : [{ id: 'doc-1', nodeKind: 'document', docType: 'module', title: 'Doc 1', sortOrder: 0, targetFiles: [], keyQuestions: [] }],
    planIdToDocId: snapshotId === 'snap-test-1'
      ? new Map([['doc-1', 'doc-1'], ['doc-2', 'doc-2']])
      : new Map([['doc-1', 'doc-1']]),
  })),
  processQueueDocument: vi.fn(async () => undefined),
}));

vi.mock('../tools/verifier-tools.js', () => ({
  createVerifierTools: () => ({ tools: [], getVerdicts: () => [], clearVerdicts: vi.fn() }),
}));

vi.mock('../wiki-store.js', () => ({
  wikiStore: {
    getDocumentsBySnapshot: vi.fn(async () => [{ id: 'doc-1' }]),
    updateSnapshotStatus: vi.fn(),
  },
}));

vi.mock('../wiki-snapshot-events.js', () => ({
  publishLatestWikiSnapshot: vi.fn(),
  WikiSnapshotEventReason: { GenerationCompleted: 'completed', GenerationFailed: 'failed' },
}));

vi.mock('../../notifications/notify.js', () => ({ notify: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { wikiWriteQueue } from '../wiki-write-queue-service.js';

describe('wikiWriteQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wikiWriteQueue.stop();
  });

  it('enqueueBatch persists batch and items', async () => {
    const batch = await wikiWriteQueue.enqueueBatch({
      snapshotId: 'snap-test-1',
      projectId: 'proj-1',
      workDir: '/tmp/repo',
      locale: 'zh',
      items: [
        { documentId: 'doc-1', documentTitle: 'Architecture', sortOrder: 0 },
        { documentId: 'doc-2', documentTitle: 'Modules', sortOrder: 1 },
      ],
    });

    expect(batch.status).toBe('running');

    const db = getDb();
    const items = await db
      .select()
      .from(wikiWriteQueueItems)
      .where(eq(wikiWriteQueueItems.batchId, batch.id));

    expect(items).toHaveLength(2);
    expect(items.every(i => i.status === 'queued' || i.status === 'running' || i.status === 'completed')).toBe(true);
  });

  it('getQueueState returns counts', async () => {
    const batch = await wikiWriteQueue.enqueueBatch({
      snapshotId: 'snap-test-2',
      projectId: 'proj-1',
      workDir: '/tmp/repo',
      items: [{ documentId: 'doc-1', documentTitle: 'Doc', sortOrder: 0 }],
    });

    const state = await wikiWriteQueue.getQueueState('snap-test-2');
    expect(state.batch?.id).toBe(batch.id);
    expect(state.items).toHaveLength(1);
    expect(state.concurrency).toBeGreaterThan(0);
  });

  it('recoverOrphaned resets running items without active session', async () => {
    wikiWriteQueue.stop();

    const db = getDb();
    const batchId = 'batch-recover-test';
    const itemId = 'item-recover-test';
    const now = new Date().toISOString();

    await db.insert(wikiWriteBatches).values({
      id: batchId,
      snapshotId: 'snap-test-3',
      projectId: 'proj-1',
      workDir: '/tmp/repo',
      locale: 'zh',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(wikiWriteQueueItems).values({
      id: itemId,
      batchId,
      snapshotId: 'snap-test-3',
      projectId: 'proj-1',
      documentId: 'doc-1',
      documentTitle: 'Doc',
      sortOrder: 0,
      status: 'running',
      sessionId: 'ars_orphan',
      createdAt: now,
      startedAt: now,
    });

    const { items: recovered } = await wikiWriteQueue.recoverOrphaned();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const after = await db.select().from(wikiWriteQueueItems).where(eq(wikiWriteQueueItems.id, itemId));
    expect(after[0].status).toBe('queued');
  });
});
