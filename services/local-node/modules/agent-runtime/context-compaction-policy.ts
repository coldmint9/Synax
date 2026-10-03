/** Server/session configuration only; historical model text is not policy input. */
export interface ContextCompactionPolicy {
  keepRecentSteps: number;
  memoryTokenBudget: number;
  /** Comparison horizon N, including the first request after the cut. */
  expectedRemainingRequests?: number;
  pricing?: {
    /** Currency per million input tokens, in the same currency as both absolute costs. */
    cachedInputPerMillion: number;
    cacheWritePerMillion: number;
    /** Absolute currency for this candidate, not token prices. */
    summaryCost: number;
    retrievalCost: number;
  };
}

export interface ContextWatermarks {
  hard: number;
  budget: number;
  prepare: number;
  high: number;
  low: number;
  minReclaim: number;
  /** Legacy diagnostic field; no additional headroom is withheld. */
  safety: number;
}

export interface ContextCompactionDecision {
  action: "keep" | "commit" | "blocked";
  reason: string;
  urgent: boolean;
  reclaimedTokens: number;
  economics: {
    /** Configured estimates, not evidence of provider-side cache hits. */
    known: boolean;
    /** Assumes the original suffix is warm and the rebuilt suffix stays warm after its first write. */
    assumption: "warm-cache";
    /** Null means unknown or no finite break-even when savings are nonpositive. */
    breakEvenRequests: number | null;
    affectedBeforeTokens: number;
    affectedAfterTokens: number | null;
    /** Full affected-suffix write cost, before the retained cached-read credit. */
    rewriteCost: number | null;
    /** Nonnegative rebuild premium plus absolute summary and retrieval costs. */
    oneTimeCost: number | null;
    savingsPerRequest: number | null;
    expectedNetSavings: number | null;
  };
}

const DEFAULT_POLICY: Readonly<ContextCompactionPolicy> = Object.freeze({
  keepRecentSteps: 2,
  memoryTokenBudget: 6_000,
});

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonnegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number`);
  }
  return value;
}

function count(value: unknown, name: string, minimum = 0): number {
  const result = nonnegative(value, name);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return result;
}

/**
 * Only retention and diagnostic pricing remain configurable. Legacy scheduling
 * fields (cap, ratios, cooldown, safety and disabled) are intentionally ignored:
 * persisted session metadata must never reinstate early automatic compaction.
 * Malformed active settings are rejected, not coerced.
 */
export function resolveContextCompactionPolicy(
  value?: unknown,
): ContextCompactionPolicy {
  const supplied =
    value === undefined ? {} : object(value, "contextCompactionPolicy");
  const field = (key: keyof ContextCompactionPolicy) =>
    supplied[key] === undefined ? DEFAULT_POLICY[key] : supplied[key];
  const policy: ContextCompactionPolicy = {
    keepRecentSteps: count(field("keepRecentSteps"), "keepRecentSteps"),
    memoryTokenBudget: count(
      field("memoryTokenBudget"),
      "memoryTokenBudget",
      1,
    ),
  };
  if (supplied.expectedRemainingRequests !== undefined) {
    policy.expectedRemainingRequests = nonnegative(
      supplied.expectedRemainingRequests,
      "expectedRemainingRequests",
    );
  }
  if (supplied.pricing !== undefined) {
    const pricing = object(supplied.pricing, "pricing");
    policy.pricing = {
      cachedInputPerMillion: nonnegative(
        pricing.cachedInputPerMillion,
        "pricing.cachedInputPerMillion",
      ),
      cacheWritePerMillion: nonnegative(
        pricing.cacheWritePerMillion,
        "pricing.cacheWritePerMillion",
      ),
      summaryCost: nonnegative(pricing.summaryCost, "pricing.summaryCost"),
      retrievalCost: nonnegative(
        pricing.retrievalCost,
        "pricing.retrievalCost",
      ),
    };
  }
  return policy;
}

/**
 * The input budget is the physical model window minus reserved output tokens.
 * Keep the historical diagnostic keys for stored traces/consumers, but every
 * threshold now denotes the same hard boundary. There is no early watermark,
 * effective-window cap, growth reserve, or half-window compaction target.
 */
export function contextWatermarks(
  _policy: ContextCompactionPolicy,
  contextLimit: number,
  outputReserve: number,
  _growthP95?: number,
): ContextWatermarks {
  count(contextLimit, "contextLimit");
  count(outputReserve, "outputReserve");
  const hard = Math.max(0, contextLimit - outputReserve);
  return {
    hard,
    budget: hard,
    prepare: hard,
    high: hard,
    low: hard,
    minReclaim: 0,
    safety: 0,
  };
}

/**
 * Warm-cache assumption: without a cut, all N requests read the original suffix
 * from cache. With a cut, the first request writes the new suffix and the other
 * N-1 requests read it from cache. Thus N * reclaimed cached-read savings pays
 * for the rebuild premium (write minus cached read on the retained suffix), plus
 * absolute summary/retrieval costs. Clamp the premium to zero rather than claim
 * a benefit from writes priced below cached reads. These are configured estimates,
 * not measured cache hits. All prices use the same currency; none are inferred.
 */
function economicsFor(
  policy: ContextCompactionPolicy,
  currentTokens: number,
  candidateTokens: number | undefined,
  stablePrefixTokens: number,
): ContextCompactionDecision["economics"] {
  const affectedBeforeTokens = Math.max(0, currentTokens - stablePrefixTokens);
  const affectedAfterTokens =
    candidateTokens === undefined
      ? null
      : Math.max(0, candidateTokens - stablePrefixTokens);
  const unknown: ContextCompactionDecision["economics"] = {
    known: false,
    assumption: "warm-cache",
    breakEvenRequests: null,
    affectedBeforeTokens,
    affectedAfterTokens,
    rewriteCost: null,
    oneTimeCost: null,
    savingsPerRequest: null,
    expectedNetSavings: null,
  };
  const { pricing, expectedRemainingRequests } = policy;
  if (
    !pricing ||
    expectedRemainingRequests === undefined ||
    affectedAfterTokens === null
  )
    return unknown;

  const rewriteCost =
    (affectedAfterTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const rebuildPremium =
    (affectedAfterTokens / 1_000_000) *
    Math.max(0, pricing.cacheWritePerMillion - pricing.cachedInputPerMillion);
  const oneTimeCost =
    rebuildPremium + pricing.summaryCost + pricing.retrievalCost;
  const savingsPerRequest =
    ((affectedBeforeTokens - affectedAfterTokens) / 1_000_000) *
    pricing.cachedInputPerMillion;
  const expectedNetSavings =
    savingsPerRequest * expectedRemainingRequests - oneTimeCost;
  const breakEvenRequests =
    savingsPerRequest > 0 ? oneTimeCost / savingsPerRequest : null;
  // Finite inputs can still overflow during arithmetic. Never report fabricated
  // savings (or serialize infinities) when the configured model is unrepresentable.
  if (
    ![rewriteCost, oneTimeCost, savingsPerRequest, expectedNetSavings].every(
      Number.isFinite,
    ) ||
    (breakEvenRequests !== null && !Number.isFinite(breakEvenRequests))
  )
    return unknown;
  return {
    known: true,
    assumption: "warm-cache",
    breakEvenRequests,
    affectedBeforeTokens,
    affectedAfterTokens,
    rewriteCost,
    oneTimeCost,
    savingsPerRequest,
    expectedNetSavings,
  };
}

/** Pure decision only: this neither builds candidates nor changes epoch state. */
export function evaluateContextCompaction(input: {
  policy: ContextCompactionPolicy;
  watermarks: ContextWatermarks;
  currentTokens: number;
  candidateTokens?: number;
  stableRequests: number;
  stablePrefixTokens?: number;
}): ContextCompactionDecision {
  const { policy, watermarks, currentTokens, candidateTokens, stableRequests } =
    input;
  count(currentTokens, "currentTokens");
  count(stableRequests, "stableRequests");
  const stablePrefixTokens = count(
    input.stablePrefixTokens ?? 0,
    "stablePrefixTokens",
  );
  if (candidateTokens !== undefined) count(candidateTokens, "candidateTokens");

  const urgent = currentTokens > watermarks.hard;
  const reclaimedTokens =
    candidateTokens === undefined ? 0 : currentTokens - candidateTokens;
  const economics = economicsFor(
    policy,
    currentTokens,
    candidateTokens,
    stablePrefixTokens,
  );
  const decide = (
    action: ContextCompactionDecision["action"],
    reason: string,
  ): ContextCompactionDecision => ({
    action,
    reason,
    urgent,
    reclaimedTokens,
    economics,
  });

  if (!urgent) return decide("keep", "within-hard-window");
  if (candidateTokens === undefined)
    return decide("blocked", "candidate-required");
  if (candidateTokens > watermarks.hard)
    return decide("blocked", "candidate-exceeds-hard");
  if (reclaimedTokens <= 0) return decide("blocked", "no-positive-reclaim");
  // Hard-window rescue cannot depend on cache economics, cooldown or a minimum
  // reclaim ratio. The first complete-prefix batch that fits is sufficient.
  return decide("commit", "hard-pressure");
}
