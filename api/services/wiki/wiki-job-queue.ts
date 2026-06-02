import { eq, and, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { wikiJobs } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { isSaturated } from '../llm-runtime/middleware/rate-limiter.js';

export type WikiJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface WikiJobInput {
  projectId: string;
  workDir: string;
  locale?: 'zh' | 'en';
  priority?: number;
}

export interface WikiJob {
  id: string;
  projectId: string;
  snapshotId: string | null;
  status: WikiJobStatus;
  priority: number;
  workDir: string;
  locale: 'zh' | 'en';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

type JobRunner = (job: WikiJob) => Promise<{ snapshotId: string }>;

const POLL_INTERVAL_MS = 2000;
const MAX_RUNNING_JOBS = 3;

class WikiJobQueue {
  private runner: JobRunner | null = null;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  setRunner(fn: JobRunner): void {
    this.runner = fn;
  }

  async enqueue(input: WikiJobInput): Promise<WikiJob> {
    const db = getDb();
    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(wikiJobs).values({
      id,
      projectId: input.projectId,
      status: 'queued',
      priority: input.priority ?? 0,
      workDir: input.workDir,
      locale: input.locale ?? 'zh',
      createdAt: now,
    });
    this.ensurePolling();
    const rows = await db.select().from(wikiJobs).where(eq(wikiJobs.id, id)).limit(1);
    return rowToJob(rows[0]);
  }

  async getJob(id: string): Promise<WikiJob | null> {
    const db = getDb();
    const rows = await db.select().from(wikiJobs).where(eq(wikiJobs.id, id)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async getRunningCount(): Promise<number> {
    const db = getDb();
    const rows = await db.select().from(wikiJobs).where(eq(wikiJobs.status, 'running'));
    return rows.length;
  }

  async recoverOrphaned(): Promise<number> {
    const db = getDb();
    const result = await db
      .update(wikiJobs)
      .set({ status: 'failed', error: 'Orphaned: server restarted', completedAt: new Date().toISOString() })
      .where(eq(wikiJobs.status, 'running'));
    return Number(result.rowsAffected ?? 0);
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
    this.tryDispatch().finally(() => {
      if (this.polling) {
        this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
      }
    });
  }

  private async tryDispatch(): Promise<void> {
    if (!this.runner) return;

    // L1↔L2 backpressure: if token bucket is saturated, hold
    if (isSaturated()) {
      logger.debug('[wiki-job-queue] token bucket saturated, holding');
      return;
    }

    const running = await this.getRunningCount();
    if (running >= MAX_RUNNING_JOBS) return;

    const db = getDb();
    const queued = await db
      .select()
      .from(wikiJobs)
      .where(eq(wikiJobs.status, 'queued'))
      .orderBy(wikiJobs.priority, wikiJobs.createdAt)
      .limit(1);

    if (queued.length === 0) return;

    const job = rowToJob(queued[0]);
    const now = new Date().toISOString();
    await db.update(wikiJobs).set({ status: 'running', startedAt: now }).where(eq(wikiJobs.id, job.id));
    job.status = 'running';
    job.startedAt = now;

    this.executeJob(job);
  }

  private async executeJob(job: WikiJob): Promise<void> {
    try {
      const result = await this.runner!(job);
      const db = getDb();
      await db.update(wikiJobs).set({
        status: 'completed',
        snapshotId: result.snapshotId,
        completedAt: new Date().toISOString(),
      }).where(eq(wikiJobs.id, job.id));
      logger.info({ jobId: job.id, snapshotId: result.snapshotId }, '[wiki-job-queue] job completed');
    } catch (err) {
      const db = getDb();
      const error = err instanceof Error ? err.message : String(err);
      await db.update(wikiJobs).set({
        status: 'failed',
        error,
        completedAt: new Date().toISOString(),
      }).where(eq(wikiJobs.id, job.id));
      logger.error({ jobId: job.id, error }, '[wiki-job-queue] job failed');
    }
  }
}

function rowToJob(r: typeof wikiJobs.$inferSelect): WikiJob {
  return {
    id: r.id,
    projectId: r.projectId,
    snapshotId: r.snapshotId ?? null,
    status: r.status as WikiJobStatus,
    priority: r.priority,
    workDir: r.workDir,
    locale: (r.locale ?? 'zh') as 'zh' | 'en',
    createdAt: r.createdAt,
    startedAt: r.startedAt ?? null,
    completedAt: r.completedAt ?? null,
    error: r.error ?? null,
  };
}

export const wikiJobQueue = new WikiJobQueue();
