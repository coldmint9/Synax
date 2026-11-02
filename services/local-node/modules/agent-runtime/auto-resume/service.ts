import { logger } from "../../../infrastructure/runtime/logger.js";
import type { AgentSession } from "../contracts.js";
import {
  AUTO_RESUME_CONCURRENCY,
  AUTO_RESUME_MAX_ATTEMPTS,
  AUTO_RESUME_MAX_SESSIONS,
  AUTO_RESUME_START_DELAY_MS,
  autoResumeBackoffMs,
  autoResumeNetworkCooldownMs,
  clearsAutoResume,
  isNetworkFailure,
  isUserStoppedSession,
  planSessionResume,
  resumeDecisionForPatch,
  type AutoResumeCause,
  type AutoResumeItem,
  type AutoResumeRecord,
  type AutoResumeSnapshot,
} from "./contracts.js";
import type { AutoResumeJournal } from "./journal.js";

export interface AutoResumeSessionSource {
  list(): AgentSession[];
  get(sessionId: string): AgentSession | undefined;
}

export interface AutoResumeChange {
  sessionId: string;
  removed: boolean;
  phase?: AutoResumeRecord["phase"];
  attempts?: number;
  nextAttemptAt?: string | null;
  online: boolean;
}

export interface SessionAutoResumeOptions {
  journal: AutoResumeJournal;
  sessions: AutoResumeSessionSource;
  /** Submit one continuation turn; a rejection means it was not accepted. */
  resume: (sessionId: string, cause: AutoResumeCause) => Promise<void>;
  isOnline: () => boolean;
  /** Sessions owned by an embedded host are resumed by that host. */
  isEmbedded?: (session: AgentSession) => boolean;
  onChange?: (change: AutoResumeChange) => void;
  now?: () => number;
  startDelayMs?: number;
  /** Called when a session needs a connectivity verdict after a network failure. */
  noteNetworkFailure?: () => void;
  /** Awaited before the startup scan so the session index is populated. */
  beforeScan?: () => Promise<void>;
  /** Re-read one session row from the runtime before acting on it. */
  refreshSession?: (sessionId: string) => Promise<void>;
  concurrency?: number;
  maxAttempts?: number;
  tickIntervalMs?: number;
}

/** Error codes a later attempt can still heal by itself. */
const RETRYABLE_CODES = new Set([
  "SESSION_BUSY",
  "RECOVERY_REQUIRED",
  "ANCESTOR_STOPPING",
  "COMPACTION_BUSY",
  "INTERACTION_PENDING",
  "PROJECTION_RECOVERING",
  "RUNTIME_TRANSPORT_UNAVAILABLE",
  "FORK_PREPARING",
  // Resuming many sessions at once can meet the worker cap; the queue retries
  // as the runtime drains.
  "SESSION_LIMIT",
]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps unfinished sessions alive across an app restart and a network outage.
 *
 * The service owns one queue. Startup fills it with leftover work, runtime
 * session patches add work that a network failure stopped, and a single loop
 * drains it. While the model endpoint is unreachable the queue holds its work
 * and spends no attempts, so a long offline stretch cannot burn the budget a
 * real transient failure needs.
 */
export class SessionAutoResumeService {
  private readonly journal: AutoResumeJournal;
  private readonly sessions: AutoResumeSessionSource;
  private readonly resumeSession: SessionAutoResumeOptions["resume"];
  private readonly isOnline: () => boolean;
  private readonly isEmbedded: (session: AgentSession) => boolean;
  private readonly onChange?: (change: AutoResumeChange) => void;
  private readonly now: () => number;
  private readonly noteNetworkFailure?: () => void;
  private readonly beforeScan?: () => Promise<void>;
  private readonly refreshSession?: (sessionId: string) => Promise<void>;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly startDelayMs: number;
  private readonly tickIntervalMs: number;
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private stopped = true;

  constructor(options: SessionAutoResumeOptions) {
    this.journal = options.journal;
    this.sessions = options.sessions;
    this.resumeSession = options.resume;
    this.isOnline = options.isOnline;
    this.isEmbedded = options.isEmbedded ?? (() => false);
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.noteNetworkFailure = options.noteNetworkFailure;
    this.beforeScan = options.beforeScan;
    this.refreshSession = options.refreshSession;
    this.concurrency = Math.max(1, options.concurrency ?? AUTO_RESUME_CONCURRENCY);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? AUTO_RESUME_MAX_ATTEMPTS);
    this.startDelayMs = Math.max(0, options.startDelayMs ?? AUTO_RESUME_START_DELAY_MS);
    this.tickIntervalMs = Math.max(50, options.tickIntervalMs ?? 1_000);
  }

  /**
   * Load the durable queue, then wait out the startup delay before touching
   * sessions: session index replay and runtime recovery own the store until then.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = undefined;
      void this.boot();
    }, this.startDelayMs);
    this.bootTimer.unref?.();
  }

  private async boot(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.journal.load();
      await this.beforeScan?.();
      this.pruneMissingSessions();
      this.collectLeftoverSessions();
      this.report();
    } catch (error) {
      logger.warn({ error }, "[auto-resume] startup scan failed");
    }
    if (this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining?.catch(() => {});
    await this.journal.flush();
  }

  get running(): boolean {
    return !this.stopped;
  }

  snapshot(): AutoResumeSnapshot {
    const online = this.isOnline();
    const items: AutoResumeItem[] = this.journal.list().map((record) => ({
      ...record,
      title: this.sessions.get(record.sessionId)?.title ?? null,
    }));
    return { online, items };
  }

  /** Forget one session: the user chose not to continue it. */
  dismiss(sessionId: string): boolean {
    this.journal.suppress(sessionId);
    const removed = this.journal.remove(sessionId);
    this.emit({ sessionId, removed: true, online: this.isOnline() });
    return removed;
  }

  /**
   * The endpoint is reachable again: release every session that was waiting on
   * the network instead of making each one sit out its retry cooldown.
   */
  releaseNetworkWait(): void {
    let released = 0;
    for (const record of this.journal.list()) {
      if (record.phase !== "waiting_network") continue;
      this.update(record.sessionId, {
        phase: "queued",
        nextAttemptAt: null,
        networkWaits: 0,
      });
      released += 1;
    }
    if (released > 0) logger.info({ released }, "[auto-resume] released network wait");
  }

  /**
   * Record sessions that are executing right now, so the next host can restore
   * them even when this one exits without a per-session status transition.
   */
  captureActiveSessions(): void {
    for (const session of this.sessions.list()) {
      if (session.parentSessionId) continue;
      if (!["running", "queued", "stopping"].includes(session.status)) continue;
      this.enqueue(session.id, "restart");
    }
    this.report();
  }

  /** Add or refresh one queued session. */
  enqueue(sessionId: string, cause: AutoResumeCause, error?: string): void {
    if (this.journal.isSuppressed(sessionId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.parentSessionId) return;
    if (session.sessionMetadata?.archivedAt || session.sessionMetadata?.deletedAt) return;
    if (this.isEmbedded(session)) return;
    const existing = this.journal.get(sessionId);
    const at = new Date(this.now()).toISOString();
    if (existing) {
      // Keep the original position in the queue; a repeat failure updates it.
      const record = this.journal.update(sessionId, {
        cause: existing.cause === "network" ? existing.cause : cause,
        // A retry deadline or a network wait outranks an optimistic queue slot.
        phase:
          existing.phase === "retrying"
            ? existing.phase
            : existing.phase === "waiting_network"
              ? "waiting_network"
              : this.isOnline()
                ? "queued"
                : "waiting_network",
        updatedAt: at,
        lastError: error ?? existing.lastError,
      });
      if (record) this.emitRecord(record);
      return;
    }
    const record = this.journal.put({
      sessionId,
      projectId: session.projectId,
      cause,
      phase: this.isOnline() ? "queued" : "waiting_network",
      attempts: 0,
      networkWaits: 0,
      enqueuedAt: at,
      updatedAt: at,
      nextAttemptAt: null,
      lastError: error ?? null,
    });
    logger.info({ sessionId, cause }, "[auto-resume] queued session");
    this.emitRecord(record);
  }

  /**
   * Translate a session status transition into queue maintenance. A completed
   * turn or a user stop clears the queue; a network failure or a restart
   * interruption fills it.
   */
  handleSessionPatch(
    sessionId: string,
    patch: {
      status?: unknown;
      blockedReason?: unknown;
      stopReason?: unknown;
      sessionMetadata?: unknown;
    },
  ): void {
    if (this.stopped) return;
    const status = typeof patch.status === "string" ? patch.status : undefined;
    if (!status) return;
    const reason =
      typeof patch.blockedReason === "string"
        ? patch.blockedReason
        : typeof patch.stopReason === "string"
          ? patch.stopReason
          : null;

    if (status === "running") {
      // A user (or this service) started the session again: let it run.
      this.journal.unsuppress(sessionId);
      this.drop(sessionId, "running");
      return;
    }
    const session = this.sessions.get(sessionId);
    const metadata =
      patch.sessionMetadata && typeof patch.sessionMetadata === "object"
        ? (patch.sessionMetadata as Record<string, unknown>)
        : undefined;
    if (
      clearsAutoResume(status, reason) ||
      ((status === "paused" || status === "interrupted") &&
        (Boolean(metadata?.manualStop) ||
          Boolean(session && isUserStoppedSession(session))))
    ) {
      this.drop(sessionId, status);
      return;
    }
    const cause = resumeDecisionForPatch(status, reason);
    if (!cause) return;
    if (isNetworkFailure(reason)) this.noteNetworkFailure?.();
    this.enqueue(sessionId, cause, typeof reason === "string" ? reason : undefined);
  }

  /** One queue pass. Exposed for tests and for an explicit nudge. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const online = this.isOnline();
    const now = this.now();
    const due: AutoResumeRecord[] = [];

    for (const record of this.journal.list()) {
      const session = this.sessions.get(record.sessionId);
      if (!session) {
        this.drop(record.sessionId, "session-missing");
        continue;
      }
      if (!online) {
        if (record.phase !== "waiting_network")
          this.update(record.sessionId, { phase: "waiting_network", nextAttemptAt: null });
        continue;
      }
      const waitUntil = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : NaN;
      const scheduled = Number.isFinite(waitUntil) && waitUntil > now;
      if (record.phase === "waiting_network") {
        // Connectivity came back without a monitor event (or the session never
        // had one): release the work once the cooldown has passed.
        if (scheduled) continue;
        this.update(record.sessionId, { phase: "queued", nextAttemptAt: null });
      } else if (scheduled) {
        // A retry with a deadline of its own is not due yet.
        continue;
      }
      due.push(record);
    }

    if (!due.length || !this.isOnline() || this.stopped) return;
    await Promise.all(due.slice(0, this.concurrency).map((record) => this.attempt(record)));
  }

  private async attempt(record: AutoResumeRecord): Promise<void> {
    const { sessionId } = record;
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    try {
      // This process keeps a copy of worker-owned rows, so a status read from it
      // can trail the worker that just settled. Read the row before deciding.
      await this.refreshSession?.(sessionId).catch(() => {});
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.drop(sessionId, "session-missing");
        return;
      }
      if (
        session.status === "completed" ||
        session.status === "cancelled" ||
        session.status === "waiting_permission" ||
        session.status === "waiting_input"
      ) {
        // The turn settled (or now needs a human) while it was queued.
        this.drop(sessionId, session.status);
        return;
      }
      // Shutdown can capture a row while the user's stop is still in flight, so
      // the queued restart outlives the stop. The abort marker, not the queue,
      // decides: a turn the user ended stays ended.
      if (isUserStoppedSession(session)) {
        this.drop(sessionId, "user-stop");
        return;
      }
      // A stop fence or an active run is not this service's to resolve.
      if (session.sessionMetadata?.runtimeControl) {
        this.retryLater(record, "Execution shutdown is still pending.");
        return;
      }
      if (session.activeRunId) {
        this.drop(sessionId, "already-running");
        return;
      }
      await this.resumeSession(sessionId, record.cause);
      logger.info(
        { sessionId, cause: record.cause, attempts: record.attempts },
        "[auto-resume] session continued",
      );
      this.drop(sessionId, "resumed");
    } catch (error) {
      this.handleFailure(record, error);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private handleFailure(record: AutoResumeRecord, error: unknown): void {
    const message = errorMessage(error);
    const code = errorCode(error);
    const sessionId = record.sessionId;

    if (isNetworkFailure(message) || isNetworkFailure(code)) {
      this.noteNetworkFailure?.();
      // Transport failures do not spend the session's attempt budget: the work
      // is fine, the route is not. The cooldown only paces the probes.
      const networkWaits = record.networkWaits + 1;
      this.update(sessionId, {
        phase: "waiting_network",
        networkWaits,
        nextAttemptAt: new Date(
          this.now() + autoResumeNetworkCooldownMs(networkWaits),
        ).toISOString(),
        lastError: message,
      });
      logger.warn({ sessionId, code }, "[auto-resume] waiting for connectivity");
      return;
    }
    if (code && !RETRYABLE_CODES.has(code)) {
      logger.warn(
        { sessionId, code, message },
        "[auto-resume] session cannot be continued automatically",
      );
      this.drop(sessionId, `unrecoverable:${code}`);
      return;
    }
    this.retryLater(record, message);
  }

  private retryLater(record: AutoResumeRecord, message: string): void {
    const attempts = record.attempts + 1;
    if (attempts >= this.maxAttempts) {
      logger.warn(
        { sessionId: record.sessionId, attempts, message },
        "[auto-resume] giving up after repeated failures",
      );
      this.drop(record.sessionId, "attempts-exhausted");
      return;
    }
    const nextAttemptAt = new Date(this.now() + autoResumeBackoffMs(attempts)).toISOString();
    this.update(record.sessionId, {
      phase: "retrying",
      attempts,
      nextAttemptAt,
      lastError: message,
    });
  }

  /** Fill the queue from what the previous host left unfinished. */
  private collectLeftoverSessions(): void {
    const now = this.now();
    const candidates = this.sessions
      .list()
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let queued = 0;
    for (const session of candidates) {
      if (queued >= AUTO_RESUME_MAX_SESSIONS) break;
      if (this.isEmbedded(session)) continue;
      if (this.journal.get(session.id)) {
        queued += 1;
        continue;
      }
      const decision = planSessionResume(session, { now });
      if (!decision.resume) continue;
      this.enqueue(session.id, decision.cause);
      queued += 1;
    }
  }

  private pruneMissingSessions(): void {
    for (const record of this.journal.list()) {
      if (this.sessions.get(record.sessionId)) continue;
      this.journal.remove(record.sessionId);
    }
  }

  private update(sessionId: string, patch: Partial<AutoResumeRecord>): void {
    const record = this.journal.update(sessionId, {
      ...patch,
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (record) this.emitRecord(record);
  }

  private drop(sessionId: string, reason: string): void {
    if (!this.journal.remove(sessionId)) return;
    logger.info({ sessionId, reason }, "[auto-resume] removed from queue");
    this.emit({ sessionId, removed: true, online: this.isOnline() });
  }

  private report(): void {
    for (const record of this.journal.list()) this.emitRecord(record);
  }

  private emitRecord(record: AutoResumeRecord): void {
    this.emit({
      sessionId: record.sessionId,
      removed: false,
      phase: record.phase,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      online: this.isOnline(),
    });
  }

  private emit(change: AutoResumeChange): void {
    try {
      this.onChange?.(change);
    } catch (error) {
      logger.warn({ error }, "[auto-resume] change listener failed");
    }
  }
}
