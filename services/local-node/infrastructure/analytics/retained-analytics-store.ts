import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT } from "../runtime/env.js";
import { logger } from "../runtime/logger.js";

export type RetiredSessionReason = "archived" | "deleted";

/**
 * One retired session's last known increment, kept outside the session record.
 *
 * A permanent delete removes the session's history directory, so the numbers it
 * already contributed cannot be recomputed afterwards. This ledger is the
 * durable copy that keeps project totals from shrinking.
 */
export interface RetiredSessionEntry {
  sessionId: string;
  projectId: string;
  title: string;
  sessionGroup: string | null;
  parentSessionId: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  retiredAt: string;
  retiredReason: RetiredSessionReason;
  /** Raw `runtimeAnalytics` projection; the reader stays the only validator. */
  analytics: unknown | null;
  /** Raw `contextUsage` projection; the reader stays the only validator. */
  contextUsage: unknown | null;
}

interface LedgerFile {
  version: 1;
  projectId: string;
  sessions: RetiredSessionEntry[];
}

const LEDGER_VERSION = 1;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isEntry(value: unknown): value is RetiredSessionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    isString(entry.sessionId) &&
    isString(entry.projectId) &&
    isString(entry.status) &&
    isString(entry.createdAt) &&
    isString(entry.updatedAt) &&
    isString(entry.retiredAt) &&
    (entry.retiredReason === "archived" || entry.retiredReason === "deleted")
  );
}

/**
 * Project-scoped, append-only ledger of retired-session analytics.
 *
 * One file per project: totals for a project stay a single bounded read, and a
 * retirement only rewrites the entries of its own project.
 */
export class RetainedAnalyticsStore {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    readonly directory = path.join(DATA_ROOT, "analytics", "retired-sessions"),
  ) {}

  private filename(projectId: string): string {
    // Project ids are free-form; a digest keeps every id inside one filename.
    return path.join(
      this.directory,
      `${createHash("sha256").update(projectId).digest("hex")}.json`,
    );
  }

  /** Missing, foreign or corrupt ledgers read as empty; totals then fall back
   * to the sessions that still exist instead of failing the analytics page. */
  async read(projectId: string): Promise<RetiredSessionEntry[]> {
    if (!projectId) return [];
    let raw: string;
    try {
      raw = await fs.readFile(this.filename(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        logger.warn(
          { error, projectId },
          "[analytics] retired-session ledger is unreadable",
        );
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      if (parsed.projectId !== projectId || !Array.isArray(parsed.sessions)) {
        logger.warn(
          { projectId },
          "[analytics] retired-session ledger does not belong to its project",
        );
        return [];
      }
      return parsed.sessions.filter(isEntry);
    } catch (error) {
      logger.warn(
        { error, projectId },
        "[analytics] retired-session ledger is corrupt",
      );
      return [];
    }
  }

  /**
   * Adds or refreshes entries by session id.
   *
   * A re-retirement (archive, then delete of that archive batch) refreshes the
   * same entry, and unrelated entries are never dropped: the requirement is
   * that recorded statistics only ever grow.
   */
  async upsert(
    projectId: string,
    entries: readonly RetiredSessionEntry[],
  ): Promise<void> {
    if (!projectId || entries.length === 0) return;
    await this.enqueue(projectId, async () => {
      const merged = new Map(
        (await this.read(projectId)).map(
          (entry) => [entry.sessionId, entry] as const,
        ),
      );
      for (const entry of entries) merged.set(entry.sessionId, entry);
      const file: LedgerFile = {
        version: LEDGER_VERSION,
        projectId,
        sessions: [...merged.values()],
      };
      const filename = this.filename(projectId);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
      await fs.rename(temporary, filename);
    });
  }

  /** Serialize writers per project; a failed write must not block the next. */
  private enqueue(projectId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    this.pending.set(projectId, settled);
    void settled.then(() => {
      if (this.pending.get(projectId) === settled)
        this.pending.delete(projectId);
    });
    return next;
  }
}

export const retainedAnalyticsStore = new RetainedAnalyticsStore();
