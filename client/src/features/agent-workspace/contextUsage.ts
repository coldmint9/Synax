import type {
  AgentSession,
  ContextUsageSnapshot,
  SessionAnalytics,
} from "../../adapters/transport/agentRuntime";

const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Reads the persisted context snapshot written by the runtime once per request.
 * No history scan, no extra stats request: the field travels with the session.
 */
export function readSessionContextUsage(
  session?: AgentSession | null,
): ContextUsageSnapshot | null {
  const raw = session?.sessionMetadata?.contextUsage;
  if (!raw || typeof raw !== "object") return null;
  const composition = raw.composition;
  if (!composition || typeof composition !== "object") return null;
  const total = tokenCount(raw.total) ? raw.total : composition.total;
  if (!tokenCount(total) || total <= 0) return null;
  const limit =
    typeof raw.limit === "number" &&
    Number.isFinite(raw.limit) &&
    raw.limit > 0
      ? raw.limit
      : null;
  return {
    version: 1,
    stepId: typeof raw.stepId === "string" ? raw.stepId : "",
    total,
    limit,
    composition,
    measuredAt:
      typeof raw.measuredAt === "string"
        ? raw.measuredAt
        : composition.measuredAt,
  };
}

export function readSessionAnalytics(
  session?: AgentSession | null,
): SessionAnalytics | null {
  const raw = session?.sessionMetadata?.runtimeAnalytics;
  return raw && typeof raw === "object" && raw.version === 1 ? raw : null;
}
