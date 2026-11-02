import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import { logger } from "../../../infrastructure/runtime/logger.js";
import {
  AUTO_RESUME_JOURNAL_LIMIT,
  type AutoResumePhase,
  type AutoResumeRecord,
} from "./contracts.js";

const JOURNAL_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 250;
/** A dismissal is a user decision; it outlives the session it was made about. */
const SUPPRESSED_LIMIT = 64;

interface JournalFile {
  version: number;
  items: AutoResumeRecord[];
  suppressed?: string[];
}

function isRecord(value: unknown): value is AutoResumeRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AutoResumeRecord>;
  return (
    typeof item.sessionId === "string" &&
    item.sessionId.length > 0 &&
    typeof item.projectId === "string" &&
    (item.phase === "queued" ||
      item.phase === "retrying" ||
      item.phase === "waiting_network")
  );
}

function normalize(value: AutoResumeRecord): AutoResumeRecord {
  return {
    sessionId: value.sessionId,
    projectId: value.projectId,
    cause: value.cause === "network" || value.cause === "manual" ? value.cause : "restart",
    phase: value.phase as AutoResumePhase,
    attempts: Number.isFinite(value.attempts) ? Math.max(0, Math.trunc(value.attempts)) : 0,
    networkWaits: Number.isFinite(value.networkWaits)
      ? Math.max(0, Math.trunc(value.networkWaits))
      : 0,
    enqueuedAt: typeof value.enqueuedAt === "string" ? value.enqueuedAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    nextAttemptAt: typeof value.nextAttemptAt === "string" ? value.nextAttemptAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

/**
 * Durable state of the auto-resume queue.
 *
 * The queue is state, not a log: a restart rewrites the same session id instead
 * of appending, so the file stays small enough to rewrite whole. Writes publish
 * by rename, so a crash can never leave half a queue behind.
 */
export class AutoResumeJournal {
  private readonly records = new Map<string, AutoResumeRecord>();
  private readonly suppressed = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private loaded = false;
  private dirty = false;

  constructor(
    private readonly file = path.resolve(
      path.isAbsolute(DATA_ROOT) ? DATA_ROOT : path.resolve(process.cwd(), DATA_ROOT),
      "runtime/session-auto-resume.json",
    ),
  ) {}

  async load(): Promise<AutoResumeRecord[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<JournalFile>;
      if (parsed?.version !== JOURNAL_VERSION) return this.list();
      for (const item of parsed.items ?? []) {
        if (!isRecord(item)) continue;
        const record = normalize(item);
        this.records.set(record.sessionId, record);
      }
      for (const sessionId of parsed.suppressed ?? [])
        if (typeof sessionId === "string" && sessionId) this.suppressed.add(sessionId);
      this.prune();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT")
        logger.warn({ error, file: this.file }, "[auto-resume] ignoring an unreadable queue file");
    }
    this.loaded = true;
    return this.list();
  }

  /** The queue is only authoritative after a successful (or absent) file read. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  list(): AutoResumeRecord[] {
    return [...this.records.values()]
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))
      .map((record) => ({ ...record }));
  }

  get(sessionId: string): AutoResumeRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? { ...record } : undefined;
  }

  size(): number {
    return this.records.size;
  }

  isSuppressed(sessionId: string): boolean {
    return this.suppressed.has(sessionId);
  }

  suppress(sessionId: string): void {
    if (this.suppressed.has(sessionId)) return;
    this.suppressed.add(sessionId);
    if (this.suppressed.size > SUPPRESSED_LIMIT) {
      const [oldest] = this.suppressed;
      if (oldest) this.suppressed.delete(oldest);
    }
    this.scheduleFlush();
  }

  unsuppress(sessionId: string): boolean {
    if (!this.suppressed.delete(sessionId)) return false;
    this.scheduleFlush();
    return true;
  }

  put(record: AutoResumeRecord): AutoResumeRecord {
    const next = normalize(record);
    this.records.set(next.sessionId, next);
    this.prune();
    this.scheduleFlush();
    return { ...next };
  }

  update(sessionId: string, patch: Partial<AutoResumeRecord>): AutoResumeRecord | undefined {
    const current = this.records.get(sessionId);
    if (!current) return undefined;
    const next = normalize({ ...current, ...patch, sessionId, projectId: current.projectId });
    this.records.set(sessionId, next);
    this.scheduleFlush();
    return { ...next };
  }

  remove(sessionId: string): boolean {
    if (!this.records.delete(sessionId)) return false;
    this.scheduleFlush();
    return true;
  }

  /** Drop the oldest entries beyond the queue budget. */
  private prune(): void {
    if (this.records.size <= AUTO_RESUME_JOURNAL_LIMIT) return;
    const ordered = [...this.records.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    for (const record of ordered.slice(AUTO_RESUME_JOURNAL_LIMIT))
      this.records.delete(record.sessionId);
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  /** Publish the queue; concurrent callers share one write. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushing) return this.flushing;
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const payload: JournalFile = {
      version: JOURNAL_VERSION,
      items: this.list(),
      suppressed: [...this.suppressed],
    };
    this.flushing = (async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(payload), "utf8");
        await rename(temporary, this.file);
      } catch (error) {
        this.dirty = true;
        logger.warn({ error, file: this.file }, "[auto-resume] queue could not be saved");
      }
    })().finally(() => {
      this.flushing = undefined;
      // A write queued while this one was in flight still needs its own turn.
      if (this.dirty) this.scheduleFlush();
    });
    return this.flushing;
  }
}
