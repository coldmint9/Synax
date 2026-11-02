import type { AgentSession } from "./contracts.js";
import {
  analyticsFromStats,
  buildProjectAnalytics,
  measuredContextUsageSnapshot,
  needsSessionAnalyticsBackfill,
  projectAnalyticsSession,
  readContextUsage,
  readSessionAnalytics,
  type ProjectAnalytics,
  type ProjectAnalyticsRetainedSession,
} from "./analytics-projection.js";
import { readRetiredSessions } from "./analytics-retention.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { projectSessionState } from "./session-projection.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

/** Sessions backfilled per request keep a first visit bounded; the client
 * re-requests while `pendingBackfill` is non-zero. */
const BACKFILL_PER_REQUEST = 8;
const BACKFILL_CONCURRENCY = 3;
const CACHE_MS = 4_000;
/** A session the user keeps open must not be mirrored on every tick. */
const BACKGROUND_INTERVAL_MS = 60_000;
const BACKGROUND_FIRST_DELAY_MS = 15_000;
/** One background pass stays bounded; the next tick continues the backlog. */
const BACKGROUND_BATCH = 64;

const inFlightBackfills = new Map<string, Promise<void>>();
const attemptedBackfills = new Set<string>();
const failedBackfills = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 60_000;
const cache = new Map<string, { at: number; value: ProjectAnalytics }>();

/**
 * Every session the project still stores.
 *
 * Archived sessions stay here on purpose: they already contributed to the
 * totals and their record is still readable. Only a permanently deleted
 * session is gone, and its numbers come from the retained ledger instead.
 */
async function sessionProjections(projectId?: string): Promise<AgentSession[]> {
  return (await runtimeFacade.listSessionProjection())
    .map((item) => projectSessionState(item as never))
    .filter(
      (session) =>
        (!projectId || session.projectId === projectId) &&
        !session.sessionMetadata?.deletedAt,
    );
}

/**
 * Sessions that keep their numbers in the totals but are not detail rows.
 *
 * An archived record still answers for itself; the ledger covers sessions whose
 * record was permanently deleted, and is skipped for any session the runtime
 * still knows so nothing is counted twice.
 */
async function retainedSessionRows(
  projectId: string,
  all: readonly AgentSession[],
): Promise<ProjectAnalyticsRetainedSession[]> {
  const rows: ProjectAnalyticsRetainedSession[] = all
    .filter((session) => session.sessionMetadata?.archivedAt)
    .map((session) => ({
      row: projectAnalyticsSession(
        session,
        readSessionAnalytics(session.sessionMetadata?.runtimeAnalytics),
        readContextUsage(session.sessionMetadata?.contextUsage),
      ),
      retiredReason: "archived" as const,
    }));
  const liveIds = new Set(all.map((session) => session.id));
  // The ledger is a cache of retired numbers, never a reason to fail the page.
  let retired: Awaited<ReturnType<typeof readRetiredSessions>> = [];
  try {
    const ledger = await readRetiredSessions(projectId);
    if (Array.isArray(ledger)) retired = ledger;
  } catch (error) {
    logger.warn(
      { error, projectId },
      "[analytics] retired-session ledger could not be read",
    );
  }
  for (const entry of retired) {
    if (liveIds.has(entry.sessionId)) continue;
    rows.push({
      row: projectAnalyticsSession(
        {
          id: entry.sessionId,
          parentSessionId: entry.parentSessionId,
          title: entry.title,
          status: entry.status as AgentSession["status"],
          createdAt: entry.createdAt,
          completedAt: entry.completedAt,
          updatedAt: entry.updatedAt,
          sessionMetadata: {
            intentCategory: entry.sessionGroup,
          } as AgentSession["sessionMetadata"],
        },
        readSessionAnalytics(entry.analytics),
        readContextUsage(entry.contextUsage),
      ),
      retiredReason: entry.retiredReason,
    });
  }
  return rows;
}

async function backfillSession(session: AgentSession): Promise<void> {
  const existing = inFlightBackfills.get(session.id);
  if (existing) return existing;
  if (attemptedBackfills.has(session.id)) return;
  const task = (async () => {
    try {
      await backfillSessionNow(session);
    } catch (error) {
      failedBackfills.set(session.id, Date.now());
      throw error;
    }
  })();
  inFlightBackfills.set(session.id, task);
  try {
    await task;
  } finally {
    inFlightBackfills.delete(session.id);
  }
}

async function backfillSessionNow(session: AgentSession): Promise<void> {
  const configuredLimit =
    typeof session.sessionMetadata?.contextLimit === "number"
      ? (session.sessionMetadata.contextLimit as number)
      : null;
  const stats = await runtimeFacade.sessionStatsAuthoritative(
    session.id,
    configuredLimit,
  );
  const analytics = analyticsFromStats(stats);
  const context = (stats.context ?? {}) as {
    requestId?: unknown;
    inputTokens?: unknown;
  };
  // Only a provider-answered request has context usage to show; without one the
  // session keeps no snapshot rather than a local estimate.
  const inputTokens = context.inputTokens;
  const contextUsage =
    typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens > 0
      ? measuredContextUsageSnapshot(
          stats.contextComposition,
          inputTokens,
          typeof context.requestId === "string" ? context.requestId : session.id,
          typeof stats.contextLimit === "number" ? stats.contextLimit : null,
        )
      : null;
  // Patch only the derived metadata keys. Do not send a full sessionMetadata
  // snapshot: another writer may have changed unrelated metadata while the
  // authoritative scan was running.
  await runtimeFacade.sessionPatch(
    session.id,
    `analytics-backfill:${session.id}:${Date.now()}`,
    {
      sessionMetadata: {
        runtimeAnalytics: analytics,
        ...(contextUsage ? { contextUsage } : {}),
      },
    },
  );
  attemptedBackfills.add(session.id);
  cache.delete(session.projectId);
}

function pendingBackfills(sessions: readonly AgentSession[]): AgentSession[] {
  const now = Date.now();
  return sessions
    .filter(
      (session) =>
        needsSessionAnalyticsBackfill(session.sessionMetadata?.runtimeAnalytics) &&
        !attemptedBackfills.has(session.id) &&
        (failedBackfills.get(session.id) ?? 0) + FAILURE_COOLDOWN_MS < now,
    )
    // Recently used sessions first: they are the ones users open.
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Mirrors up to `limit` pending sessions; returns how many stay pending. */
async function backfillBatch(
  sessions: readonly AgentSession[],
  limit: number,
): Promise<number> {
  const pending = pendingBackfills(sessions);
  const batch = pending.slice(0, limit);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batch.length) {
      const session = batch[cursor++];
      try {
        await backfillSession(session);
      } catch {
        /* A legacy session may be unreachable; it stays counted as pending. */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BACKFILL_CONCURRENCY, batch.length) }, worker),
  );
  return Math.max(0, pending.length - batch.length);
}

export async function projectAnalytics(
  projectId: string,
): Promise<ProjectAnalytics> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let sessions = await sessionProjections(projectId);
  const pending = await backfillBatch(sessions, BACKFILL_PER_REQUEST);
  // Backfilled patches land in the projection; re-read once so the response
  // contains the freshly persisted aggregates.
  sessions = await sessionProjections(projectId);
  const pendingAfter = sessions.filter(
    (session) =>
      needsSessionAnalyticsBackfill(session.sessionMetadata?.runtimeAnalytics),
  ).length;
  const retained = await retainedSessionRows(projectId, sessions);
  const value = buildProjectAnalytics(
    projectId,
    sessions
      .filter((session) => !session.sessionMetadata?.archivedAt)
      .map((session) => ({
        session,
        analytics: readSessionAnalytics(
          session.sessionMetadata?.runtimeAnalytics,
        ),
        contextUsage: readContextUsage(session.sessionMetadata?.contextUsage),
      })),
    Math.max(pending, pendingAfter),
    new Date().toISOString(),
    retained,
  );
  cache.set(projectId, { at: Date.now(), value });
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * Mirrors every legacy session once, for all projects.
 *
 * Historical aggregates must not depend on somebody opening the analytics page:
 * a freshly upgraded install would otherwise show partial totals until then.
 */
export async function runAnalyticsBackfillPass(
  limit = BACKGROUND_BATCH,
): Promise<number> {
  return backfillBatch(await sessionProjections(), limit);
}

let backgroundTimer: ReturnType<typeof setInterval> | null = null;
let backgroundKickoff: ReturnType<typeof setTimeout> | null = null;
let backgroundPass: Promise<void> | null = null;
let backgroundStopped = false;

function runBackgroundPass(): Promise<void> {
  // A cold replay can outlast the timer; share the pass instead of stacking
  // concurrent scans of every historical session.
  return (backgroundPass ??= (async () => {
    try {
      const pending = await runAnalyticsBackfillPass();
      if (pending > 0)
        logger.debug(
          { pending },
          "[agent-runtime] analytics backfill continues on the next pass",
        );
    } catch (error) {
      logger.warn({ error }, "[agent-runtime] analytics backfill pass failed");
    } finally {
      backgroundPass = null;
    }
  })());
}

export function startAnalyticsBackfill(): void {
  if (backgroundTimer || backgroundStopped) return;
  // Recovery owns the store for the first seconds of a launch; queue key
  // generation must not compete with it.
  backgroundKickoff = setTimeout(() => {
    backgroundKickoff = null;
    void runBackgroundPass();
  }, BACKGROUND_FIRST_DELAY_MS);
  backgroundKickoff.unref?.();
  backgroundTimer = setInterval(() => {
    void runBackgroundPass();
  }, BACKGROUND_INTERVAL_MS);
  backgroundTimer.unref?.();
}

export async function stopAnalyticsBackfill(): Promise<void> {
  backgroundStopped = true;
  if (backgroundKickoff) clearTimeout(backgroundKickoff);
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundKickoff = null;
  backgroundTimer = null;
  await backgroundPass?.catch(() => {});
}

export function invalidateProjectAnalytics(projectId?: string): void {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
