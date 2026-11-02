import { normalizeUsage } from "../../infrastructure/llm-runtime/usage.js";
import { measuredContextUsageSnapshot } from "./analytics-projection.js";

type MeasuredContextStore = {
  getRunStep(id: string): { metadata?: Record<string, unknown> | null };
  updateSessionMetadata(id: string, patch: Record<string, unknown>): unknown;
};

/**
 * Record the provider's own usage for the request this step sent.
 *
 * The displayed context occupancy is the provider's billed input, never a local
 * guess, so the composer cannot drift between an estimate and the real value.
 * The step's request composition is only reused to split that measured total
 * into categories; when it is unavailable the total still stands alone.
 */
export function persistMeasuredContextUsage(
  store: MeasuredContextStore,
  sessionId: string,
  stepId: string,
  usage: unknown,
  limit?: number | null,
): void {
  // A length-limited answer is continued by further requests inside one step,
  // and the runtime reports their usage summed. That sum is billed work, not
  // the size of one request, so it cannot become the context occupancy.
  const requests =
    usage !== null && typeof usage === "object"
      ? (usage as { providerRequestCount?: unknown }).providerRequestCount
      : undefined;
  if (typeof requests === "number" && requests > 1) return;
  const input = normalizeUsage(usage)?.normalization.input;
  if (input?.status !== "known" || typeof input.value !== "number") return;
  const snapshot = measuredContextUsageSnapshot(
    store.getRunStep(stepId).metadata?.contextComposition,
    input.value,
    stepId,
    limit ?? null,
  );
  if (snapshot) store.updateSessionMetadata(sessionId, { contextUsage: snapshot });
}
