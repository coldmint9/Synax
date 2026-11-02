import { retainedAnalyticsStore, type RetiredSessionEntry, type RetiredSessionReason } from "../../infrastructure/analytics/retained-analytics-store.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import type { AgentSession } from "./contracts.js";
import { normalizeIntentCategory } from "./session-classification.js";
import { onSessionRetired } from "./session-store.js";

export type { RetiredSessionEntry, RetiredSessionReason };

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The ledger entry for one retiring session.
 *
 * Retirement is the last moment the projected aggregates exist, so this copies
 * them verbatim instead of recomputing: the analytics reader stays the only
 * place that validates projection versions.
 */
export function retiredSessionEntry(
  session: AgentSession,
  reason: RetiredSessionReason,
  now = new Date().toISOString(),
): RetiredSessionEntry | null {
  if (!session?.id || !session.projectId) return null;
  const metadata = recordValue(session.sessionMetadata);
  return {
    sessionId: session.id,
    projectId: session.projectId,
    title:
      session.title?.trim() || session.prompt?.slice(0, 120) || session.id,
    sessionGroup: normalizeIntentCategory(metadata.intentCategory),
    parentSessionId: session.parentSessionId ?? null,
    status: typeof session.status === "string" ? session.status : "completed",
    createdAt: session.createdAt,
    completedAt: session.completedAt ?? null,
    updatedAt: session.updatedAt,
    retiredAt: now,
    retiredReason: reason,
    analytics: metadata.runtimeAnalytics ?? null,
    contextUsage: metadata.contextUsage ?? null,
  };
}

/** Retired sessions a project already recorded; empty when the ledger is new. */
export async function readRetiredSessions(
  projectId: string,
): Promise<RetiredSessionEntry[]> {
  return retainedAnalyticsStore.read(projectId);
}

let dispose: (() => void) | null = null;

/**
 * Records every archived or deleted session before its record disappears, so
 * project statistics keep the contribution it already made.
 *
 * Idempotent: startup and a restart of the HTTP host share one subscription.
 */
export function registerAnalyticsRetention(): () => void {
  if (dispose) return dispose;
  const off = onSessionRetired(({ session, reason }) => {
    const entry = retiredSessionEntry(session, reason);
    if (!entry) return;
    // The retirement must never wait on (or fail because of) the ledger write.
    void retainedAnalyticsStore
      .upsert(entry.projectId, [entry])
      .catch((error) =>
        logger.warn(
          { error, sessionId: entry.sessionId },
          "[analytics] retired session could not be recorded",
        ),
      );
  });
  dispose = () => {
    off();
    dispose = null;
  };
  return dispose;
}
