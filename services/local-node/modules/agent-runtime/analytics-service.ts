import type { AgentSession } from "./contracts.js";
import {
  analyticsFromStats,
  buildProjectAnalytics,
  contextUsageSnapshot,
  readContextUsage,
  readSessionAnalytics,
  type ProjectAnalytics,
} from "./analytics-projection.js";
import { projectSessionState } from "./session-projection.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

/** Sessions backfilled per request keep a first visit bounded; the client
 * re-requests while `pendingBackfill` is non-zero. */
const BACKFILL_PER_REQUEST = 8;
const BACKFILL_CONCURRENCY = 3;
const CACHE_MS = 4_000;

const inFlightBackfills = new Map<string, Promise<void>>();
const attemptedBackfills = new Set<string>();
const failedBackfills = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 60_000;
const cache = new Map<string, { at: number; value: ProjectAnalytics }>();

async function sessionProjections(projectId: string): Promise<AgentSession[]> {
  return (await runtimeFacade.listSessionProjection())
    .map((item) => projectSessionState(item as never))
    .filter(
      (session) =>
        session.projectId === projectId &&
        !session.sessionMetadata?.archivedAt &&
        !session.sessionMetadata?.deletedAt,
    );
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
  const context = (stats.context ?? {}) as { requestId?: unknown };
  const composition = stats.contextComposition;
  const contextUsage =
    composition && typeof composition === "object"
      ? contextUsageSnapshot(
          composition,
          typeof context.requestId === "string"
            ? context.requestId
            : session.id,
          typeof stats.contextLimit === "number" ? stats.contextLimit : null,
        )
      : null;
  // Re-read the projection before patching: a live turn may have written
  // context usage or analytics while the legacy scan was running.
  const fresh = (await runtimeFacade.uiSnapshotAuthoritative(session.id))
    .session;
  await runtimeFacade.sessionPatch(
    session.id,
    `analytics-backfill:${session.id}:${Date.now()}`,
    {
      sessionMetadata: {
        ...(fresh?.sessionMetadata ?? session.sessionMetadata ?? {}),
        runtimeAnalytics: analytics,
        ...(contextUsage ? { contextUsage } : {}),
      },
    },
  );
  attemptedBackfills.add(session.id);
  cache.delete(session.projectId);
}

async function backfillMissing(sessions: AgentSession[]): Promise<number> {
  const now = Date.now();
  const missing = sessions.filter(
    (session) =>
      !readSessionAnalytics(session.sessionMetadata?.runtimeAnalytics) &&
      !attemptedBackfills.has(session.id) &&
      (failedBackfills.get(session.id) ?? 0) + FAILURE_COOLDOWN_MS < now,
  );
  // Recently used sessions first: they are the ones the page shows on top.
  missing.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const batch = missing.slice(0, BACKFILL_PER_REQUEST);
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
  return Math.max(0, missing.length - batch.length);
}

export async function projectAnalytics(
  projectId: string,
): Promise<ProjectAnalytics> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let sessions = await sessionProjections(projectId);
  const pending = await backfillMissing(sessions);
  // Backfilled patches land in the projection; re-read once so the response
  // contains the freshly persisted aggregates.
  sessions = await sessionProjections(projectId);
  const pendingAfter = sessions.filter(
    (session) => !readSessionAnalytics(session.sessionMetadata?.runtimeAnalytics),
  ).length;
  const value = buildProjectAnalytics(
    projectId,
    sessions.map((session) => ({
      session,
      analytics: readSessionAnalytics(session.sessionMetadata?.runtimeAnalytics),
      contextUsage: readContextUsage(session.sessionMetadata?.contextUsage),
    })),
    Math.max(pending, pendingAfter),
  );
  cache.set(projectId, { at: Date.now(), value });
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return value;
}

export function invalidateProjectAnalytics(projectId?: string): void {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
