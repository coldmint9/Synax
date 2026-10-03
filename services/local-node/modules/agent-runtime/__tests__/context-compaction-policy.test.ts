import { describe, expect, it } from "vitest";
import {
  contextWatermarks,
  evaluateContextCompaction,
  resolveContextCompactionPolicy,
  type ContextCompactionDecision,
  type ContextCompactionPolicy,
} from "../context-compaction-policy.js";

const defaults = { keepRecentSteps: 2, memoryTokenBudget: 6_000 };

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

const legacyPolicy = {
  effectiveWindowCap: 120_000,
  prepareRatio: 0.65,
  highRatio: 0.8,
  lowRatio: 0.5,
  minStableRequests: 8,
  minReclaimRatio: 0.2,
  safetyTokens: 1024,
  disabled: false,
};

describe("resolveContextCompactionPolicy", () => {
  it("only defaults retention and memory settings", () => {
    expect(resolveContextCompactionPolicy()).toEqual(defaults);
  });

  it.each([false, true])(
    "ignores old scheduling fields even with disabled=%s",
    (disabled) => {
      expect(
        resolveContextCompactionPolicy({ ...legacyPolicy, disabled }),
      ).toEqual(defaults);
    },
  );

  it("copies retained settings without mutating configuration", () => {
    const config = Object.freeze({ keepRecentSteps: 3 });
    expect(resolveContextCompactionPolicy(config)).toEqual({
      ...defaults,
      ...config,
    });
    const first = resolveContextCompactionPolicy();
    first.keepRecentSteps = 0;
    expect(resolveContextCompactionPolicy().keepRecentSteps).toBe(2);
    const source = pricedPolicy();
    const copy = resolveContextCompactionPolicy(source);
    expect(copy.pricing).toEqual(source.pricing);
    expect(copy.pricing).not.toBe(source.pricing);
  });

  it.each([null, false, "policy", 42, []])(
    "rejects non-object configuration %j",
    (value) => {
      expect(() => resolveContextCompactionPolicy(value)).toThrow();
    },
  );

  it.each([
    { keepRecentSteps: -1 },
    { keepRecentSteps: 1.5 },
    { memoryTokenBudget: 0 },
    { memoryTokenBudget: "6000" },
    { expectedRemainingRequests: NaN },
    { expectedRemainingRequests: -1 },
    { pricing: {} },
    { pricing: null },
    ...[
      "cachedInputPerMillion",
      "cacheWritePerMillion",
      "summaryCost",
      "retrievalCost",
    ].map((key) => ({
      pricing: {
        cachedInputPerMillion: 1,
        cacheWritePerMillion: 1,
        summaryCost: 0,
        retrievalCost: 0,
        [key]: -1,
      },
    })),
  ])("rejects invalid active settings %j", (value) => {
    expect(() => resolveContextCompactionPolicy(value)).toThrow();
  });
});

describe("physical context budget", () => {
  it.each([200_000, 1_000_000, 1_048_576])(
    "uses the full %i-token model window minus output reserve",
    (limit) => {
      const policy = resolveContextCompactionPolicy(legacyPolicy);
      expect(contextWatermarks(policy, limit, 8192, 100_000)).toEqual({
        hard: limit - 8192,
        budget: limit - 8192,
        prepare: limit - 8192,
        high: limit - 8192,
        low: limit - 8192,
        minReclaim: 0,
        safety: 0,
      });
    },
  );

  it.each([0, 1, 8, 100])(
    "handles a tiny window of %i without negative budgets",
    (limit) => {
      const marks = contextWatermarks(
        resolveContextCompactionPolicy(),
        limit,
        8,
      );
      expect(marks.hard).toBe(Math.max(0, limit - 8));
      expect(marks.budget).toBe(marks.hard);
    },
  );

  it.each([
    [-1, 0],
    [Infinity, 0],
    [1.5, 0],
    [200_000, -1],
    [200_000, NaN],
  ])("rejects invalid context/output limits %j %j", (limit, reserve) => {
    expect(() =>
      contextWatermarks(resolveContextCompactionPolicy(), limit, reserve),
    ).toThrow();
  });
});

describe("hard-window-only compaction", () => {
  it.each([0, 60_000, 95_000, 120_000, 200_000, 500_000, 920_001, 991_808])(
    "keeps %i tokens intact in a 1M window regardless of legacy policy",
    (currentTokens) => {
      const policy = resolveContextCompactionPolicy(legacyPolicy);
      for (const stableRequests of [0, 8, 100]) {
        expect(
          evaluate({
            policy,
            watermarks: contextWatermarks(policy, 1_000_000, 8192),
            currentTokens,
            candidateTokens: undefined,
            stableRequests,
          }),
        ).toMatchObject({
          action: "keep",
          reason: "within-hard-window",
          urgent: false,
        });
      }
    },
  );

  it("only commits above hard pressure and accepts an exact-fit candidate", () => {
    const policy = pricedPolicy({ expectedRemainingRequests: 0 });
    const watermarks = contextWatermarks(policy, 1_000_000, 8192);
    expect(
      evaluate({
        policy,
        watermarks,
        currentTokens: watermarks.hard + 1,
        candidateTokens: watermarks.hard,
        stableRequests: 0,
      }),
    ).toMatchObject({
      action: "commit",
      reason: "hard-pressure",
      urgent: true,
      reclaimedTokens: 1,
    });
    expect(
      evaluate({
        policy,
        watermarks,
        currentTokens: watermarks.hard,
        candidateTokens: 60_000,
      }).action,
    ).toBe("keep");
  });

  it("blocks overflow without a fitting candidate", () => {
    for (const candidateTokens of [undefined, 192_001, 200_000]) {
      expect(
        evaluate({ currentTokens: 200_000, candidateTokens }),
      ).toMatchObject({ action: "blocked", urgent: true });
    }
  });

  it.each([
    { currentTokens: -1 },
    { currentTokens: NaN },
    { candidateTokens: 1.5 },
    { stableRequests: -1 },
    { stablePrefixTokens: Infinity },
  ])("rejects malformed usage %j", (overrides) => {
    expect(() => evaluate(overrides)).toThrow();
  });
});

describe("diagnostic economics (never a compaction gate)", () => {
  it("uses currency per million only for token prices, and excludes the stable prefix", () => {
    const decision = evaluate({
      policy: pricedPolicy(),
      stablePrefixTokens: 20_000,
    });
    expect(decision.action).toBe("keep");
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
    ).toBe("keep");
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
    expect(decision.action).toBe("keep");
    expect(
      evaluate({
        ...input,
        policy: { ...policy, expectedRemainingRequests: 10 },
      }).action,
    ).toBe("keep");
    expect(
      evaluate({
        ...input,
        policy: { ...policy, expectedRemainingRequests: 10.9 },
      }).action,
    ).toBe("keep");
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

  it("keeps context on both sides of the break-even horizon", () => {
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
    ).toBe("keep");
    expect(
      evaluate({
        policy: pricedPolicy({ pricing, expectedRemainingRequests: 4 }),
        stablePrefixTokens: 20_000,
      }).action,
    ).toBe("keep");
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
      expect(decision.action).toBe("keep");
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
        action: "keep",
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
    expect(decision.action).toBe("keep");
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
