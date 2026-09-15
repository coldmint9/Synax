import { describe, expect, it } from "vitest";
import {
  contextWatermarks,
  evaluateContextCompaction,
  resolveContextCompactionPolicy,
  type ContextCompactionDecision,
  type ContextCompactionPolicy,
  type ContextWatermarks,
} from "../context-compaction-policy.js";

const defaults = {
  effectiveWindowCap: 120_000,
  prepareRatio: 0.65,
  highRatio: 0.8,
  lowRatio: 0.5,
  minStableRequests: 8,
  minReclaimRatio: 0.2,
  keepRecentSteps: 2,
  memoryTokenBudget: 6_000,
  safetyTokens: 1_024,
};

function evaluate(
  overrides: Partial<Parameters<typeof evaluateContextCompaction>[0]> = {},
): ContextCompactionDecision {
  const policy = overrides.policy ?? resolveContextCompactionPolicy();
  return evaluateContextCompaction({
    policy,
    watermarks: contextWatermarks(policy, 200_000, 8_000),
    currentTokens: 100_000,
    candidateTokens: 60_000,
    stableRequests: 8,
    ...overrides,
  });
}

function pricedPolicy(
  overrides: Record<string, unknown> = {},
): ContextCompactionPolicy {
  return resolveContextCompactionPolicy({
    expectedRemainingRequests: 10,
    pricing: {
      cachedInputPerMillion: 2,
      cacheWritePerMillion: 10,
      summaryCost: 0.2,
      retrievalCost: 0.1,
    },
    ...overrides,
  });
}

describe("resolveContextCompactionPolicy", () => {
  it("uses exactly the documented defaults, with unknown economics", () => {
    expect(resolveContextCompactionPolicy()).toEqual(defaults);
  });

  it("defaults missing fields, copies values, and does not mutate configuration", () => {
    const config = Object.freeze({ highRatio: 0.9, keepRecentSteps: 3 });
    expect(resolveContextCompactionPolicy(config)).toEqual({
      ...defaults,
      ...config,
    });
    const first = resolveContextCompactionPolicy();
    first.highRatio = 0.95;
    expect(resolveContextCompactionPolicy().highRatio).toBe(0.8);
  });

  it.each([null, false, "policy", 42, []])(
    "rejects non-object configuration %j",
    (value) => {
      expect(() => resolveContextCompactionPolicy(value)).toThrow();
    },
  );

  it.each([
    { effectiveWindowCap: 0 },
    { effectiveWindowCap: 1.5 },
    { effectiveWindowCap: Number.MAX_VALUE },
    { highRatio: NaN },
    { lowRatio: -0.1 },
    { prepareRatio: Infinity },
    { highRatio: 1 },
    { lowRatio: 0.7 },
    { prepareRatio: 0.8 },
    { highRatio: 0.65 },
    { minStableRequests: -1 },
    { minStableRequests: 1.5 },
    { minReclaimRatio: 0 },
    { minReclaimRatio: 1.1 },
    { keepRecentSteps: -1 },
    { memoryTokenBudget: 0 },
    { safetyTokens: -1 },
    { safetyTokens: "1024" },
    { expectedRemainingRequests: NaN },
    { expectedRemainingRequests: -1 },
    { pricing: {} },
    { pricing: null },
    {
      pricing: {
        cachedInputPerMillion: -1,
        cacheWritePerMillion: 1,
        summaryCost: 0,
        retrievalCost: 0,
      },
    },
    {
      pricing: {
        cachedInputPerMillion: 1,
        cacheWritePerMillion: Infinity,
        summaryCost: 0,
        retrievalCost: 0,
      },
    },
    {
      pricing: {
        cachedInputPerMillion: 1,
        cacheWritePerMillion: 1,
        summaryCost: NaN,
        retrievalCost: 0,
      },
    },
    {
      pricing: {
        cachedInputPerMillion: 1,
        cacheWritePerMillion: 1,
        summaryCost: 0,
        retrievalCost: -1,
      },
    },
  ])("rejects invalid numbers, ordering, or incomplete prices: %j", (value) => {
    expect(() => resolveContextCompactionPolicy(value)).toThrow();
  });

  it("accepts explicit zero costs, horizon, cooldown, retention and safety", () => {
    expect(
      resolveContextCompactionPolicy({
        expectedRemainingRequests: 0,
        minStableRequests: 0,
        keepRecentSteps: 0,
        safetyTokens: 0,
        pricing: {
          cachedInputPerMillion: 0,
          cacheWritePerMillion: 0,
          summaryCost: 0,
          retrievalCost: 0,
        },
      }),
    ).toMatchObject({
      expectedRemainingRequests: 0,
      minStableRequests: 0,
      safetyTokens: 0,
    });
  });

  it("copies pricing rather than retaining mutable configuration", () => {
    const source = pricedPolicy();
    const copy = resolveContextCompactionPolicy(source);
    expect(copy.pricing).toEqual(source.pricing);
    expect(copy.pricing).not.toBe(source.pricing);
  });
});

describe("contextWatermarks", () => {
  it("exposes all thresholds and uses the effective cap after output reservation", () => {
    const marks: ContextWatermarks = contextWatermarks(
      resolveContextCompactionPolicy(),
      200_000,
      8_000,
    );
    expect(marks).toEqual({
      hard: 192_000,
      budget: 118_976,
      safety: 1_024,
      prepare: 77_334,
      high: 95_180,
      low: 59_488,
      minReclaim: 23_795,
    });
    expect(
      contextWatermarks(resolveContextCompactionPolicy(), 100_000, 8_000)
        .budget,
    ).toBe(90_976);
  });

  it("reserves measured growth, bounded to ten percent of the effective window", () => {
    const policy = resolveContextCompactionPolicy();
    expect(contextWatermarks(policy, 200_000, 8_000, 2_000)).toMatchObject({
      safety: 3_024,
      budget: 116_976,
    });
    expect(
      contextWatermarks(policy, 200_000, 8_000, Number.MAX_SAFE_INTEGER),
    ).toMatchObject({
      safety: 13_024,
      budget: 106_976,
    });
  });

  it("bounds safety for tiny windows without manufacturing context capacity", () => {
    const policy = resolveContextCompactionPolicy();
    for (const contextLimit of [0, 1, 2, 3, 8, 10, 64, 1_000]) {
      for (const outputReserve of [0, 1, contextLimit, contextLimit + 1]) {
        const marks = contextWatermarks(
          policy,
          contextLimit,
          outputReserve,
          1_000_000,
        );
        expect(marks.hard).toBe(Math.max(0, contextLimit - outputReserve));
        expect(marks.budget).toBe(marks.hard - marks.safety);
        expect(marks.safety).toBeLessThanOrEqual(Math.floor(marks.hard * 0.2));
        expect(marks.low).toBeGreaterThanOrEqual(0);
        expect(marks.low).toBeLessThanOrEqual(marks.prepare);
        expect(marks.prepare).toBeLessThanOrEqual(marks.high);
        expect(marks.high).toBeLessThanOrEqual(marks.budget);
        expect(marks.minReclaim).toBeLessThanOrEqual(marks.budget);
        for (const value of Object.values(marks))
          expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });

  it.each([
    [-1, 0, 0],
    [NaN, 0, 0],
    [10, -1, 0],
    [10, Infinity, 0],
    [10, 0, -1],
    [10, 0, NaN],
  ])(
    "rejects invalid window measurements %j/%j/%j",
    (limit, reserve, growth) => {
      expect(() =>
        contextWatermarks(
          resolveContextCompactionPolicy(),
          limit,
          reserve,
          growth,
        ),
      ).toThrow();
    },
  );
});

describe("evaluateContextCompaction", () => {
  it("keeps below prepare and prepares without committing below high", () => {
    expect(evaluate({ currentTokens: 70_000 })).toMatchObject({
      action: "keep",
      urgent: false,
    });
    expect(
      evaluate({ currentTokens: 80_000, candidateTokens: 30_000 }),
    ).toMatchObject({ action: "prepare", urgent: false });
  });

  it("uses inclusive prepare and high thresholds, but strict budget pressure", () => {
    const watermarks = contextWatermarks(
      resolveContextCompactionPolicy(),
      200_000,
      8_000,
    );
    expect(evaluate({ currentTokens: watermarks.prepare }).action).toBe(
      "prepare",
    );
    expect(evaluate({ currentTokens: watermarks.high }).action).toBe("commit");
    expect(
      evaluate({ currentTokens: watermarks.budget, stableRequests: 0 }),
    ).toMatchObject({ action: "defer-cooldown", urgent: false });
    expect(
      evaluate({ currentTokens: watermarks.budget + 1, stableRequests: 0 }),
    ).toMatchObject({ action: "commit", urgent: true });
  });

  it("prepares a missing optional candidate but blocks if urgent and none exists", () => {
    expect(evaluate({ candidateTokens: undefined }).action).toBe("prepare");
    expect(
      evaluate({ currentTokens: 120_000, candidateTokens: undefined }),
    ).toMatchObject({ action: "blocked", urgent: true });
  });

  it("defers cooldown and accepts its exact boundary", () => {
    expect(evaluate({ stableRequests: 7 }).action).toBe("defer-cooldown");
    expect(evaluate({ stableRequests: 8 }).action).toBe("commit");
  });

  it("defers small gains, including no gain and negative gain", () => {
    for (const candidateTokens of [90_000, 100_000, 110_000]) {
      expect(evaluate({ candidateTokens }).action).toBe("defer-small-gain");
    }
    const minReclaim = contextWatermarks(
      resolveContextCompactionPolicy(),
      200_000,
      8_000,
    ).minReclaim;
    expect(evaluate({ candidateTokens: 100_000 - minReclaim }).action).toBe(
      "commit",
    );
    expect(evaluate({ candidateTokens: 100_000 - minReclaim + 1 }).action).toBe(
      "defer-small-gain",
    );
  });

  it("commits an eligible batch, reporting reclaim and a nonempty reason", () => {
    const decision = evaluate();
    expect(decision).toMatchObject({
      action: "commit",
      urgent: false,
      reclaimedTokens: 40_000,
    });
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it.each([193_000, 192_001])(
    "hard pressure at %i overrides cooldown, cost and minimum reclaim",
    (currentTokens) => {
      expect(
        evaluate({
          policy: pricedPolicy({ expectedRemainingRequests: 0 }),
          currentTokens,
          candidateTokens: Math.min(currentTokens - 1, 192_000),
          stableRequests: 0,
        }),
      ).toMatchObject({ action: "commit", urgent: true });
    },
  );

  it("defers repeated tiny cuts that would leave the candidate above budget", () => {
    const policy = pricedPolicy({ expectedRemainingRequests: 0 });
    const watermarks = contextWatermarks(policy, 200_000, 8_000);
    for (const currentTokens of [120_000, 121_000, watermarks.hard]) {
      for (const stableRequests of [0, 8, 20]) {
        expect(
          evaluate({
            policy,
            watermarks,
            currentTokens,
            candidateTokens: currentTokens - 1,
            stableRequests,
          }),
        ).toMatchObject({ action: "defer-small-gain", urgent: true });
      }
    }
  });

  it("budget pressure still overrides optional gates when a tiny cut reaches budget", () => {
    const policy = pricedPolicy({ expectedRemainingRequests: 0 });
    const watermarks = contextWatermarks(policy, 200_000, 8_000);
    for (const candidateTokens of [watermarks.budget, watermarks.budget - 1]) {
      expect(
        evaluate({
          policy,
          watermarks,
          currentTokens: watermarks.budget + 1,
          candidateTokens,
          stableRequests: 0,
        }),
      ).toMatchObject({ action: "commit", urgent: true });
    }
  });

  it("permits meaningful budget-pressure cuts at the exact minimum reclaim", () => {
    const policy = pricedPolicy({ expectedRemainingRequests: 0 });
    const watermarks = contextWatermarks(policy, 200_000, 8_000);
    const currentTokens = 160_000;
    expect(
      evaluate({
        policy,
        watermarks,
        currentTokens,
        candidateTokens: currentTokens - watermarks.minReclaim,
        stableRequests: 0,
      }),
    ).toMatchObject({ action: "commit", urgent: true });
    expect(
      evaluate({
        policy,
        watermarks,
        currentTokens,
        candidateTokens: currentTokens - watermarks.minReclaim + 1,
        stableRequests: 0,
      }),
    ).toMatchObject({ action: "defer-small-gain", urgent: true });
  });

  it("blocks an oversized candidate, including a positive gain under urgency", () => {
    expect(
      evaluate({ currentTokens: 210_000, candidateTokens: 192_001 }),
    ).toMatchObject({ action: "blocked", urgent: true });
    expect(evaluate({ candidateTokens: 192_001 }).action).toBe("blocked");
    expect(
      evaluate({ currentTokens: 210_000, candidateTokens: 192_000 }).action,
    ).toBe("commit");
  });

  it("requires positive gain even when urgent", () => {
    for (const candidateTokens of [120_000, 120_001]) {
      expect(
        evaluate({ currentTokens: 120_000, candidateTokens }),
      ).toMatchObject({ action: "blocked", urgent: true });
    }
  });

  it("allows a zero-token candidate and handles an exhausted window", () => {
    const watermarks = contextWatermarks(
      resolveContextCompactionPolicy(),
      8,
      8,
    );
    expect(
      evaluate({ watermarks, currentTokens: 1, candidateTokens: 0 }),
    ).toMatchObject({ action: "commit", urgent: true });
    expect(
      evaluate({ watermarks, currentTokens: 1, candidateTokens: 1 }).action,
    ).toBe("blocked");
    expect(
      evaluate({ watermarks, currentTokens: 0, candidateTokens: undefined })
        .action,
    ).toBe("keep");
  });

  it.each([
    { currentTokens: NaN },
    { currentTokens: -1 },
    { candidateTokens: Infinity },
    { candidateTokens: -1 },
    { stableRequests: -1 },
    { stablePrefixTokens: -1 },
  ])("rejects invalid decision measurements %j", (overrides) => {
    expect(() => evaluate(overrides)).toThrow();
  });

  it("does not mutate frozen inputs", () => {
    const policy = Object.freeze(resolveContextCompactionPolicy());
    const watermarks = Object.freeze(contextWatermarks(policy, 200_000, 8_000));
    const input = Object.freeze({
      policy,
      watermarks,
      currentTokens: 100_000,
      candidateTokens: 60_000,
      stableRequests: 8,
    });
    expect(evaluateContextCompaction(input)).toEqual(
      evaluateContextCompaction(input),
    );
  });
});

describe("optional economic gate", () => {
  it("uses currency per million only for token prices, and excludes the stable prefix", () => {
    const decision = evaluate({
      policy: pricedPolicy(),
      stablePrefixTokens: 20_000,
    });
    expect(decision.action).toBe("commit");
    expect(decision.economics).toMatchObject({
      known: true,
      affectedBeforeTokens: 80_000,
      affectedAfterTokens: 40_000,
    });
    expect(decision.economics.rewriteCost).toBeCloseTo(0.4);
    expect(decision.economics.oneTimeCost).toBeCloseTo(0.62);
    expect(decision.economics.savingsPerRequest).toBeCloseTo(0.08);
    expect(decision.economics.breakEvenRequests).toBeCloseTo(7.75);
    expect(decision.economics.expectedNetSavings).toBeCloseTo(0.18);
    expect(
      evaluate({ policy: pricedPolicy({ expectedRemainingRequests: 9 }) })
        .action,
    ).toBe("defer-cost");
  });

  it("reports the warm-cache 80k-to-30k break-even including the first post-cut request", () => {
    // $0.02 is the absolute summary cost: 20,000 ordinary tokens at $1/M.
    const policy = pricedPolicy({
      expectedRemainingRequests: 11,
      pricing: {
        cachedInputPerMillion: 0.1,
        cacheWritePerMillion: 1.25,
        summaryCost: 0.02,
        retrievalCost: 0,
      },
    });
    // The 20k unchanged prefix is excluded, leaving affected suffixes 80k -> 30k.
    const input = {
      policy,
      currentTokens: 100_000,
      candidateTokens: 50_000,
      stablePrefixTokens: 20_000,
    };
    const decision = evaluate(input);
    expect(decision.economics).toMatchObject({
      known: true,
      assumption: "warm-cache",
      affectedBeforeTokens: 80_000,
      affectedAfterTokens: 30_000,
    });
    expect(decision.economics.rewriteCost).toBeCloseTo(0.0375);
    expect(decision.economics.oneTimeCost).toBeCloseTo(0.0545);
    expect(decision.economics.savingsPerRequest).toBeCloseTo(0.005);
    expect(decision.economics.breakEvenRequests).toBeCloseTo(10.9);
    expect(decision.economics.expectedNetSavings).toBeCloseTo(0.0005);
    expect(decision.action).toBe("commit");
    expect(
      evaluate({
        ...input,
        policy: { ...policy, expectedRemainingRequests: 10 },
      }).action,
    ).toBe("defer-cost");
    expect(
      evaluate({
        ...input,
        policy: { ...policy, expectedRemainingRequests: 10.9 },
      }).action,
    ).toBe("commit");
    // Direct comparison: N warm original reads vs one rewritten suffix + N-1 reads.
    const originalCost = (11 * 80_000 * 0.1) / 1_000_000;
    const compactedCost =
      (30_000 * 1.25) / 1_000_000 + (10 * 30_000 * 0.1) / 1_000_000 + 0.02;
    expect(decision.economics.expectedNetSavings).toBeCloseTo(
      originalCost - compactedCost,
    );
  });

  it.each([1, 2])(
    "clamps rebuild premium to zero when write price %i is no higher than cached read",
    (cacheWritePerMillion) => {
      const policy = pricedPolicy({
        pricing: {
          cachedInputPerMillion: 2,
          cacheWritePerMillion,
          summaryCost: 0.2,
          retrievalCost: 0.1,
        },
      });
      const decision = evaluate({ policy, stablePrefixTokens: 20_000 });
      expect(decision.economics.oneTimeCost).toBeCloseTo(0.3);
      expect(decision.economics.rewriteCost).toBeCloseTo(
        (40_000 / 1_000_000) * cacheWritePerMillion,
      );
      expect(decision.economics.breakEvenRequests).toBeCloseTo(3.75);
    },
  );

  it("defers below break-even and permits the exact horizon boundary", () => {
    const pricing = {
      cachedInputPerMillion: 2,
      cacheWritePerMillion: 10,
      summaryCost: 0,
      retrievalCost: 0,
    };
    expect(
      evaluate({
        policy: pricedPolicy({ pricing, expectedRemainingRequests: 3 }),
        stablePrefixTokens: 20_000,
      }).action,
    ).toBe("defer-cost");
    expect(
      evaluate({
        policy: pricedPolicy({ pricing, expectedRemainingRequests: 4 }),
        stablePrefixTokens: 20_000,
      }).action,
    ).toBe("commit");
  });

  it.each([
    {},
    { expectedRemainingRequests: 10 },
    {
      pricing: {
        cachedInputPerMillion: 2,
        cacheWritePerMillion: 10,
        summaryCost: 0,
        retrievalCost: 0,
      },
    },
  ])(
    "does not invent savings if either horizon or pricing is missing: %j",
    (config) => {
      const decision = evaluate({
        policy: resolveContextCompactionPolicy(config),
      });
      expect(decision.action).toBe("commit");
      expect(decision.economics).toMatchObject({
        known: false,
        breakEvenRequests: null,
        savingsPerRequest: null,
        expectedNetSavings: null,
      });
    },
  );

  it("has unknown economics without a candidate, even with complete prices", () => {
    expect(
      evaluate({ policy: pricedPolicy(), candidateTokens: undefined })
        .economics,
    ).toMatchObject({ known: false, breakEvenRequests: null });
  });

  it.each([0, 10])(
    "handles zero cached-read price with write price %i without fictional savings",
    (cacheWritePerMillion) => {
      const policy = pricedPolicy({
        pricing: {
          cachedInputPerMillion: 0,
          cacheWritePerMillion,
          summaryCost: 0,
          retrievalCost: 0,
        },
      });
      const decision = evaluate({ policy });
      expect(decision).toMatchObject({
        action: "defer-cost",
        economics: {
          known: true,
          savingsPerRequest: 0,
          breakEvenRequests: null,
        },
      });
      expect(decision.economics.expectedNetSavings).toBeLessThanOrEqual(0);
      expect(JSON.stringify(decision)).not.toMatch(/NaN|Infinity/);
    },
  );

  it("clamps affected suffixes rather than charging for the stable prefix", () => {
    const decision = evaluate({
      policy: pricedPolicy(),
      stablePrefixTokens: 110_000,
    });
    expect(decision.economics).toMatchObject({
      affectedBeforeTokens: 0,
      affectedAfterTokens: 0,
      rewriteCost: 0,
      savingsPerRequest: 0,
      breakEvenRequests: null,
    });
    expect(decision.action).toBe("defer-cost");
  });

  it("treats arithmetic overflow as unknown, not a fake economic benefit", () => {
    const policy = pricedPolicy({
      expectedRemainingRequests: Number.MAX_VALUE,
      pricing: {
        cachedInputPerMillion: Number.MAX_VALUE,
        cacheWritePerMillion: Number.MAX_VALUE,
        summaryCost: Number.MAX_VALUE,
        retrievalCost: Number.MAX_VALUE,
      },
    });
    expect(evaluate({ policy }).economics).toMatchObject({
      known: false,
      breakEvenRequests: null,
    });
  });
});
