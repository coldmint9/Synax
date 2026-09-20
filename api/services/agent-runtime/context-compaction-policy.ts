/** Server/session configuration only; historical model text is not policy input. */
export interface ContextCompactionPolicy {
  effectiveWindowCap: number;
  prepareRatio: number;
  highRatio: number;
  lowRatio: number;
  minStableRequests: number;
  minReclaimRatio: number;
  keepRecentSteps: number;
  memoryTokenBudget: number;
  safetyTokens: number;
  /**
   * Temporary kill switch for the automatic compaction sawtooth: suppress
   * prepare/high actions and ignore effectiveWindowCap. Hard-window rescue
   * and explicit manual compaction still apply. Defaults from
   * SYNAX_DISABLE_CONTEXT_COMPACTION when the session policy omits it.
   */
  disabled?: boolean;
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
  /** Effective safety headroom, including the bounded growth margin. */
  safety: number;
}

export interface ContextCompactionDecision {
  action:
    | "keep"
    | "prepare"
    | "commit"
    | "defer-cooldown"
    | "defer-cost"
    | "defer-small-gain"
    | "blocked";
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
  effectiveWindowCap: 120_000,
  prepareRatio: 0.65,
  highRatio: 0.8,
  lowRatio: 0.5,
  minStableRequests: 8,
  minReclaimRatio: 0.2,
  keepRecentSteps: 2,
  memoryTokenBudget: 6_000,
  safetyTokens: 1_024,
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

function ratio(value: unknown, name: string): number {
  const result = nonnegative(value, name);
  if (result <= 0 || result > 1) {
    throw new RangeError(`${name} must be in (0, 1]`);
  }
  return result;
}

/** Missing fields default; malformed supplied values are rejected, not coerced. */
export function resolveContextCompactionPolicy(
  value?: unknown,
): ContextCompactionPolicy {
  const supplied =
    value === undefined ? {} : object(value, "contextCompactionPolicy");
  const field = (key: keyof ContextCompactionPolicy) =>
    supplied[key] === undefined ? DEFAULT_POLICY[key] : supplied[key];
  const policy: ContextCompactionPolicy = {
    effectiveWindowCap: count(
      field("effectiveWindowCap"),
      "effectiveWindowCap",
      1,
    ),
    prepareRatio: ratio(field("prepareRatio"), "prepareRatio"),
    highRatio: ratio(field("highRatio"), "highRatio"),
    lowRatio: ratio(field("lowRatio"), "lowRatio"),
    minStableRequests: count(field("minStableRequests"), "minStableRequests"),
    minReclaimRatio: ratio(field("minReclaimRatio"), "minReclaimRatio"),
    keepRecentSteps: count(field("keepRecentSteps"), "keepRecentSteps"),
    memoryTokenBudget: count(
      field("memoryTokenBudget"),
      "memoryTokenBudget",
      1,
    ),
    safetyTokens: count(field("safetyTokens"), "safetyTokens"),
  };
  if (supplied.disabled !== undefined) {
    if (typeof supplied.disabled !== "boolean") {
      throw new TypeError("contextCompactionPolicy.disabled must be a boolean");
    }
    policy.disabled = supplied.disabled;
  }
  if (
    !(
      policy.lowRatio < policy.prepareRatio &&
      policy.prepareRatio < policy.highRatio &&
      policy.highRatio < 1
    )
  ) {
    throw new RangeError(
      "Watermarks must satisfy 0 < lowRatio < prepareRatio < highRatio < 1",
    );
  }
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
 * Reserve output first, then cap the effective window. Base safety and measured
 * growth each reserve at most 10% of that window, so defaults and growth outliers
 * cannot consume a tiny window. `safety` exposes their combined effective reserve.
 * Thresholds round down (at least one token for a nonempty budget); tiny windows
 * may necessarily have equal watermarks. Low is a candidate target, not a gate:
 * the caller must preserve whole steps and required evidence over reaching it.
 * A disabled policy ignores the cap and spans the physical hard window, so
 * only genuine hard-window pressure remains.
 */
export function contextWatermarks(
  policy: ContextCompactionPolicy,
  contextLimit: number,
  outputReserve: number,
  growthP95?: number,
): ContextWatermarks {
  count(contextLimit, "contextLimit");
  count(outputReserve, "outputReserve");
  const growth = nonnegative(growthP95 ?? 0, "growthP95");
  const hard = Math.max(0, contextLimit - outputReserve);
  const available = policy.disabled
    ? hard
    : Math.min(hard, policy.effectiveWindowCap);
  const marginLimit = Math.floor(available / 10);
  const safety =
    Math.min(policy.safetyTokens, marginLimit) +
    Math.min(Math.ceil(growth), marginLimit);
  const budget = available - safety;
  const threshold = (fraction: number) =>
    budget === 0 ? 0 : Math.max(1, Math.floor(budget * fraction));
  return {
    hard,
    budget,
    prepare: threshold(policy.prepareRatio),
    high: threshold(policy.highRatio),
    low: threshold(policy.lowRatio),
    minReclaim: threshold(policy.minReclaimRatio),
    safety,
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

  const urgent =
    currentTokens > watermarks.budget || currentTokens > watermarks.hard;
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

  if (!urgent && (currentTokens === 0 || currentTokens < watermarks.prepare)) {
    return decide("keep", "below-prepare");
  }
  if (!urgent && currentTokens < watermarks.high)
    return decide("prepare", "prepare-watermark");
  if (candidateTokens === undefined) {
    return decide(urgent ? "blocked" : "prepare", "candidate-required");
  }
  if (candidateTokens > watermarks.hard)
    return decide("blocked", "candidate-exceeds-hard");
  if (reclaimedTokens <= 0)
    return decide(
      urgent ? "blocked" : "defer-small-gain",
      "no-positive-reclaim",
    );
  // Budget/cap pressure alone must not trigger tiny cuts on every request when
  // the candidate would still be over budget. Actual hard-window pressure keeps
  // the positive-gain override; reaching budget or reclaiming a batch also suffices.
  if (
    urgent &&
    currentTokens <= watermarks.hard &&
    candidateTokens > watermarks.budget &&
    reclaimedTokens < watermarks.minReclaim
  ) {
    return decide("defer-small-gain", "budget-pressure-insufficient-reclaim");
  }
  if (urgent)
    return decide(
      "commit",
      currentTokens > watermarks.hard ? "hard-pressure" : "budget-pressure",
    );
  if (reclaimedTokens < watermarks.minReclaim)
    return decide("defer-small-gain", "insufficient-reclaim");
  if (stableRequests < policy.minStableRequests)
    return decide("defer-cooldown", "epoch-cooldown");
  if (
    economics.known &&
    (economics.breakEvenRequests === null ||
      policy.expectedRemainingRequests! < economics.breakEvenRequests)
  ) {
    return decide("defer-cost", "horizon-below-break-even");
  }
  return decide("commit", "high-watermark");
}
