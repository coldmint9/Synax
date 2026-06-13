import { eq, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { wikiWriteBatches, wikiWriteQueueItems } from '../../db/schema.js';
import { WIKI_WRITE_CONCURRENCY } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { isSaturated } from '../llm-runtime/middleware/rate-limiter.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { notify } from '../notifications/notify.js';
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js';
import { wikiStore } from './wiki-store.js';
import { publishLatestWikiSnapshot, WikiSnapshotEventReason } from './wiki-snapshot-events.js';
import {
  loadOutlineForSnapshot,
  loadScanForBatch,
  processQueueDocument,
} from './wiki-document-processor.js';
import { createVerifierTools } from './tools/verifier-tools.js';
import { isWritableOutlineEntry } from './tools/outline-node.js';
import type { CodeMapScanResult } from '../contracts/code-map.js';

export type WikiWriteBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type WikiWriteQueueItemStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface WikiWriteBatch {
  id: string;
  snapshotId: string;
  projectId: string;
  workDir: string;
  locale: 'zh' | 'en';
  status: WikiWriteBatchStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface WikiWriteQueueItem {
  id: string;
  batchId: string;
  snapshotId: string;
  projectId: string;
  documentId: string;
  documentTitle: string;
  sortOrder: number;
  status: WikiWriteQueueItemStatus;
  sessionId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EnqueueBatchItem {
  documentId: string;
  documentTitle: string;
  sortOrder: number;
}

export interface EnqueueBatchInput {
  snapshotId: string;
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
  items: EnqueueBatchItem[];
}

export interface WikiWriteQueueState {
  batch: WikiWriteBatch | null;
  items: WikiWriteQueueItem[];
  runningCount: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
  concurrency: number;
  rateLimited: boolean;
}

const POLL_INTERVAL_MS = 1500;
const RATE_LIMIT_NOTIFY_INTERVAL_MS = 30_000;

interface BatchRuntimeContext {
  scan: CodeMapScanResult;
  verifierHandle: ReturnType<typeof createVerifierTools>;
  registeredToolIds: string[];
}

function wikiMsg(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    genTitle: 'Wiki Generation',
    genComplete: (count: number) => `Successfully generated ${count} documents`,
    genFailed: 'Wiki Generation Failed',
  } : {
    genTitle: 'Wiki 生成',
    genComplete: (count: number) => `成功生成 ${count} 篇文档`,
    genFailed: 'Wiki 生成失败',
  };
}

function rowToBatch(row: typeof wikiWriteBatches.$inferSelect): WikiWriteBatch {
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    projectId: row.projectId,
    workDir: row.workDir,
    locale: (row.locale ?? 'zh') as 'zh' | 'en',
    status: row.status as WikiWriteBatchStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
    error: row.error ?? null,
  };
}

function rowToItem(row: typeof wikiWriteQueueItems.$inferSelect): WikiWriteQueueItem {
  return {
    id: row.id,
    batchId: row.batchId,
    snapshotId: row.snapshotId,
    projectId: row.projectId,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    sortOrder: row.sortOrder,
    status: row.status as WikiWriteQueueItemStatus,
    sessionId: row.sessionId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

class WikiWriteQueueService {
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private readonly batchContexts = new Map<string, BatchRuntimeContext>();
  private readonly lastRateLimitedNotifyAt = new Map<string, number>();

  async enqueueBatch(input: EnqueueBatchInput): Promise<WikiWriteBatch> {
    if (input.items.length === 0) {
      throw new Error('Cannot enqueue empty write batch');
    }

    const db = getDb();
    const batchId = nanoid();
    const now = new Date().toISOString();

    await db.insert(wikiWriteBatches).values({
      id: batchId,
      snapshotId: input.snapshotId,
      projectId: input.projectId,
      workDir: input.workDir,
      locale: input.locale ?? 'zh',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(wikiWriteQueueItems).values(
      input.items.map(item => ({
        id: nanoid(),
        batchId,
        snapshotId: input.snapshotId,
        projectId: input.projectId,
        documentId: item.documentId,
        documentTitle: item.documentTitle,
        sortOrder: item.sortOrder,
        status: 'queued',
        createdAt: now,
      })),
    );

    logger.info(
      { batchId, snapshotId: input.snapshotId, itemCount: input.items.length },
      '[wiki-write-queue] batch enqueued',
    );

    this.start();
    const rows = await db.select().from(wikiWriteBatches).where(eq(wikiWriteBatches.id, batchId)).limit(1);
    return rowToBatch(rows[0]);
  }

  async getQueueState(snapshotId: string): Promise<WikiWriteQueueState> {
    const db = getDb();
    const batches = await db
      .select()
      .from(wikiWriteBatches)
      .where(eq(wikiWriteBatches.snapshotId, snapshotId))
      .orderBy(wikiWriteBatches.createdAt);

    const activeBatch = [...batches].reverse().find(b => b.status === 'running')
      ?? batches[batches.length - 1]
      ?? null;

    if (!activeBatch) {
      return {
        batch: null,
        items: [],
        runningCount: 0,
        queuedCount: 0,
        completedCount: 0,
        failedCount: 0,
        concurrency: WIKI_WRITE_CONCURRENCY,
        rateLimited: isSaturated(),
      };
    }

    const items = await db
      .select()
      .from(wikiWriteQueueItems)
      .where(eq(wikiWriteQueueItems.batchId, activeBatch.id))
      .orderBy(asc(wikiWriteQueueItems.sortOrder));

    const mapped = items.map(rowToItem);
    return {
      batch: rowToBatch(activeBatch),
      items: mapped,
      runningCount: mapped.filter(i => i.status === 'running').length,
      queuedCount: mapped.filter(i => i.status === 'queued').length,
      completedCount: mapped.filter(i => i.status === 'completed').length,
      failedCount: mapped.filter(i => i.status === 'failed').length,
      concurrency: WIKI_WRITE_CONCURRENCY,
      rateLimited: isSaturated(),
    };
  }

  async recoverOrphaned(): Promise<{ batches: number; items: number }> {
    const db = getDb();
    const now = new Date().toISOString();

    const runningItems = await db
      .select()
      .from(wikiWriteQueueItems)
      .where(eq(wikiWriteQueueItems.status, 'running'));

    let itemsRecovered = 0;
    for (const item of runningItems) {
      const sessionActive = item.sessionId
        ? (() => {
            const session = agentRuntimeStore.tryGetSession(item.sessionId!);
            return session != null && session.status === 'running';
          })()
        : false;

      if (!sessionActive) {
        await db.update(wikiWriteQueueItems).set({
          status: 'queued',
          sessionId: null,
          startedAt: null,
          error: 'Recovered after server restart',
        }).where(eq(wikiWriteQueueItems.id, item.id));
        itemsRecovered++;
      }
    }

    const runningBatches = await db
      .select()
      .from(wikiWriteBatches)
      .where(eq(wikiWriteBatches.status, 'running'));

    let batchesRecovered = 0;
    for (const batch of runningBatches) {
      const batchItems = await db
        .select()
        .from(wikiWriteQueueItems)
        .where(eq(wikiWriteQueueItems.batchId, batch.id));

      const hasPending = batchItems.some(i => i.status === 'queued' || i.status === 'running');
      if (hasPending) {
        await db.update(wikiWriteBatches).set({ updatedAt: now }).where(eq(wikiWriteBatches.id, batch.id));
        batchesRecovered++;
      } else {
        await this.finalizeBatchIfDone(batch.id);
      }
    }

    if (itemsRecovered > 0 || batchesRecovered > 0) {
      logger.warn(
        { itemsRecovered, batchesRecovered },
        '[wiki-write-queue] recovered orphaned queue state',
      );
    }

    return { batches: batchesRecovered, items: itemsRecovered };
  }

  resume(): void {
    this.start();
  }

  start(): void {
    this.ensurePolling();
  }

  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private ensurePolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.poll();
  }

  private poll(): void {
    if (!this.polling) return;
    this.tryDispatch()
      .catch(err => logger.error({ err }, '[wiki-write-queue] dispatch error'))
      .finally(() => {
        if (this.polling) {
          this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        }
      });
  }

  private async getGlobalRunningCount(): Promise<number> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiWriteQueueItems)
      .where(eq(wikiWriteQueueItems.status, 'running'));
    return rows.length;
  }

  private async tryDispatch(): Promise<void> {
    if (isSaturated()) {
      await this.notifyRateLimitedIfNeeded();
      return;
    }

    const slots = WIKI_WRITE_CONCURRENCY - this.inFlight;
    if (slots <= 0) return;

    const db = getDb();
    const globalRunning = await this.getGlobalRunningCount();
    const available = Math.min(slots, WIKI_WRITE_CONCURRENCY - globalRunning);
    if (available <= 0) return;

    for (let i = 0; i < available; i++) {
      const runningBatches = await db
        .select()
        .from(wikiWriteBatches)
        .where(eq(wikiWriteBatches.status, 'running'))
        .orderBy(wikiWriteBatches.createdAt);

      let claimed: WikiWriteQueueItem | null = null;
      let batch: WikiWriteBatch | null = null;

      for (const batchRow of runningBatches) {
        const queued = await db
          .select()
          .from(wikiWriteQueueItems)
          .where(and(
            eq(wikiWriteQueueItems.batchId, batchRow.id),
            eq(wikiWriteQueueItems.status, 'queued'),
          ))
          .orderBy(asc(wikiWriteQueueItems.sortOrder))
          .limit(1);

        if (queued.length === 0) continue;

        const now = new Date().toISOString();
        await db.update(wikiWriteQueueItems).set({
          status: 'running',
          startedAt: now,
        }).where(eq(wikiWriteQueueItems.id, queued[0].id));

        claimed = rowToItem({ ...queued[0], status: 'running', startedAt: now });
        batch = rowToBatch(batchRow);
        break;
      }

      if (!claimed || !batch) break;
      void this.executeItem(batch, claimed);
    }
  }

  private async notifyRateLimitedIfNeeded(): Promise<void> {
    const db = getDb();
    const runningBatches = await db
      .select()
      .from(wikiWriteBatches)
      .where(eq(wikiWriteBatches.status, 'running'))
      .orderBy(wikiWriteBatches.createdAt);

    const now = Date.now();
    for (const batchRow of runningBatches) {
      const queued = await db
        .select()
        .from(wikiWriteQueueItems)
        .where(and(
          eq(wikiWriteQueueItems.batchId, batchRow.id),
          eq(wikiWriteQueueItems.status, 'queued'),
        ))
        .limit(1);
      if (queued.length === 0) continue;

      const last = this.lastRateLimitedNotifyAt.get(batchRow.snapshotId) ?? 0;
      if (now - last < RATE_LIMIT_NOTIFY_INTERVAL_MS) continue;

      this.lastRateLimitedNotifyAt.set(batchRow.snapshotId, now);
      const locale = (batchRow.locale ?? 'zh') as 'zh' | 'en';
      notify({
        type: TaskNotificationEventType.TaskProgress,
        taskKind: 'wiki_generate',
        projectId: batchRow.projectId,
        taskId: batchRow.snapshotId,
        title: wikiMsg(locale).genTitle,
        message: locale === 'en'
          ? 'Waiting for LLM rate limit to clear'
          : '等待 LLM 速率限制恢复',
        severity: 'info',
        meta: {
          snapshotId: batchRow.snapshotId,
          snapshotStatus: 'writing',
          rateLimited: true,
        },
      });
    }
  }

  private async getOrCreateBatchContext(batch: WikiWriteBatch): Promise<BatchRuntimeContext> {
    const existing = this.batchContexts.get(batch.id);
    if (existing) return existing;

    const { scan } = await loadScanForBatch(batch.workDir, batch.projectId);
    const verifierHandle = createVerifierTools(scan);
    const registeredToolIds: string[] = [];
    for (const tool of verifierHandle.tools) {
      toolRegistry.register(tool);
      registeredToolIds.push(tool.id);
    }

    const ctx: BatchRuntimeContext = { scan, verifierHandle, registeredToolIds };
    this.batchContexts.set(batch.id, ctx);
    return ctx;
  }

  private releaseBatchContext(batchId: string): void {
    const ctx = this.batchContexts.get(batchId);
    if (!ctx) return;
    for (const toolId of ctx.registeredToolIds) {
      toolRegistry.unregister(toolId);
    }
    this.batchContexts.delete(batchId);
  }

  private async executeItem(batch: WikiWriteBatch, item: WikiWriteQueueItem): Promise<void> {
    this.inFlight++;
    const db = getDb();

    try {
      const ctx = await this.getOrCreateBatchContext(batch);
      const { outline, planIdToDocId } = await loadOutlineForSnapshot(batch.snapshotId);
      const entry = outline.find(e => e.id === item.documentId);
      if (!entry || !isWritableOutlineEntry(entry)) {
        throw new Error(`Document ${item.documentId} is not writable`);
      }

      const batchItems = await db
        .select()
        .from(wikiWriteQueueItems)
        .where(eq(wikiWriteQueueItems.batchId, batch.id))
        .orderBy(asc(wikiWriteQueueItems.sortOrder));
      const itemIndex = batchItems.findIndex(i => i.id === item.id);
      const totalItems = batchItems.filter(i => {
        const e = outline.find(o => o.id === i.documentId);
        return e && isWritableOutlineEntry(e);
      }).length;

      await processQueueDocument({
        batch,
        item,
        entry,
        itemIndex,
        totalItems,
        outline,
        planIdToDocId,
        scan: ctx.scan,
        verifierHandle: ctx.verifierHandle,
        onWriterSessionCreated: async (sessionId) => {
          await db.update(wikiWriteQueueItems).set({ sessionId }).where(eq(wikiWriteQueueItems.id, item.id));
        },
      });

      const now = new Date().toISOString();
      await db.update(wikiWriteQueueItems).set({
        status: 'completed',
        completedAt: now,
        error: null,
      }).where(eq(wikiWriteQueueItems.id, item.id));

      logger.info({ batchId: batch.id, itemId: item.id, title: item.documentTitle }, '[wiki-write-queue] item completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, batchId: batch.id, itemId: item.id }, '[wiki-write-queue] item failed');

      await db.update(wikiWriteQueueItems).set({
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      }).where(eq(wikiWriteQueueItems.id, item.id));
    } finally {
      this.inFlight--;
      await this.finalizeBatchIfDone(batch.id);
    }
  }

  private async finalizeBatchIfDone(batchId: string): Promise<void> {
    const db = getDb();
    const batchRows = await db.select().from(wikiWriteBatches).where(eq(wikiWriteBatches.id, batchId)).limit(1);
    const batchRow = batchRows[0];
    if (!batchRow || batchRow.status !== 'running') return;

    const items = await db
      .select()
      .from(wikiWriteQueueItems)
      .where(eq(wikiWriteQueueItems.batchId, batchId));

    const pending = items.filter(i => i.status === 'queued' || i.status === 'running');
    if (pending.length > 0) return;

    const failed = items.filter(i => i.status === 'failed');
    const completed = items.filter(i => i.status === 'completed');
    const now = new Date().toISOString();
    const locale = (batchRow.locale ?? 'zh') as 'zh' | 'en';
    const { projectId, snapshotId } = batchRow;

    const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
    const docIds = documents.map(d => d.id);

    if (failed.length > 0) {
      await db.update(wikiWriteBatches).set({
        status: 'failed',
        error: `${failed.length} of ${items.length} documents failed`,
        completedAt: now,
        updatedAt: now,
      }).where(eq(wikiWriteBatches.id, batchId));

      await wikiStore.updateSnapshotStatus(snapshotId, 'failed', docIds);
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.GenerationFailed);
      notify({
        type: TaskNotificationEventType.TaskFailed,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshotId,
        title: wikiMsg(locale).genFailed,
        message: `${failed.length} document(s) failed to generate`,
        severity: 'error',
        meta: { snapshotId, failedCount: failed.length, completedCount: completed.length },
      });
    } else {
      await db.update(wikiWriteBatches).set({
        status: 'completed',
        completedAt: now,
        updatedAt: now,
        error: null,
      }).where(eq(wikiWriteBatches.id, batchId));

      await wikiStore.updateSnapshotStatus(snapshotId, 'ready', docIds);
      await publishLatestWikiSnapshot(projectId, WikiSnapshotEventReason.GenerationCompleted);
      notify({
        type: TaskNotificationEventType.TaskCompleted,
        taskKind: 'wiki_generate',
        projectId,
        taskId: snapshotId,
        title: wikiMsg(locale).genTitle,
        message: wikiMsg(locale).genComplete(completed.length),
        severity: 'success',
        meta: { snapshotId, docCount: completed.length },
      });
    }

    this.releaseBatchContext(batchId);
    logger.info({ batchId, snapshotId, completed: completed.length, failed: failed.length }, '[wiki-write-queue] batch finalized');
  }
}

export const wikiWriteQueue = new WikiWriteQueueService();
