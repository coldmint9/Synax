import { normalizeUsage, type UsageContext } from "../llm-runtime/usage.js";

export interface CacheUsageSample {
  stepId: string;
  measuredAt: string;
  model: string | null;
  unit: "request" | "external-turn";
  inputTokens: number | null;
  cacheReadTokens: number | null;
  ratio: number | null;
  status: "reported" | "missing" | "invalid" | "empty";
  inputSource: string;
  cacheSource: string;
}
export interface CacheUsageSummary {
  inputTokens: number;
  cacheReadTokens: number;
  ratio: number | null;
  weightedRatio: number | null;
  empty: number;
  aggregated: number;
  samples: number;
  matched: number;
  missing: number;
  invalid: number;
}
export interface SessionCacheUsage {
  latest: CacheUsageSample | null;
  recent: CacheUsageSummary;
  session: CacheUsageSummary;
  recentSamples: CacheUsageSample[];
  pending: number;
}

/** Re-read retained wire evidence instead of trusting an old derived ratio. */
export function cacheUsageSample(
  identity: Pick<CacheUsageSample, "stepId" | "measuredAt" | "model" | "unit">,
  value: unknown,
  context: UsageContext,
): CacheUsageSample {
  const original = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const u = normalizeUsage({ ...original, normalization: undefined }, context);
  const input = u?.normalization.input;
  const read = u?.normalization.cacheRead;
  const i = input?.value ?? null;
  const r = read?.value ?? null;
  const status = i === null || r === null ? "missing"
    : r > i ? "invalid" : i === 0 ? "empty" : "reported";
  return {
    ...identity,
    inputTokens: i,
    cacheReadTokens: r,
    ratio: status === "reported" ? r! / i! : null,
    status,
    inputSource: input?.source ?? "missing",
    cacheSource: read?.source ?? "missing",
  };
}

function summarize(samples: CacheUsageSample[]): CacheUsageSummary {
  const result: CacheUsageSummary = {
    inputTokens: 0, cacheReadTokens: 0, ratio: null, weightedRatio: null, empty: 0, aggregated: 0,
    samples: samples.length, matched: 0, missing: 0, invalid: 0,
  };
  let sumRatios = 0;
  for (const sample of samples) {
    if (sample.unit === "external-turn") { result.aggregated++; continue; }
    if (sample.status === "missing") result.missing++;
    else if (sample.status === "invalid") result.invalid++;
    else if (sample.status === "empty") result.empty++;
    else {
      result.matched++;
      sumRatios += sample.ratio!;
      result.inputTokens += sample.inputTokens!;
      result.cacheReadTokens += sample.cacheReadTokens!;
    }
  }
  if (result.matched > 0) result.ratio = sumRatios / result.matched;
  if (result.inputTokens > 0) result.weightedRatio = result.cacheReadTokens / result.inputTokens;
  return result;
}

/** Last ten actual observations, not last ten cache hits or known samples. */
export function projectCacheUsage(samples: CacheUsageSample[], pending = 0): SessionCacheUsage {
  const recent = samples.slice(-10);
  return {
    latest: samples.at(-1) ?? null,
    recent: summarize(recent),
    session: summarize(samples),
    recentSamples: recent.toReversed(),
    pending,
  };
}

/** Streaming equivalent of projectCacheUsage: cumulative accounting is exact,
 * while only the ten display samples are retained in memory. */
export class CacheUsageAccumulator {
  private readonly total = summarize([]);
  private readonly recent: CacheUsageSample[] = [];
  private sumRatios = 0;
  push(sample: CacheUsageSample): void {
    this.recent.push(sample);
    if (this.recent.length > 10) this.recent.shift();
    const one = summarize([sample]);
    for (const key of ["inputTokens", "cacheReadTokens", "empty", "aggregated", "samples", "matched", "missing", "invalid"] as const)
      this.total[key] += one[key];
    if (sample.unit !== "external-turn" && sample.status === "reported") this.sumRatios += sample.ratio!;
  }
  result(pending: number): SessionCacheUsage {
    return { ...projectCacheUsage(this.recent, pending), session: {
      ...this.total,
      ratio: this.total.matched ? this.sumRatios / this.total.matched : null,
      weightedRatio: this.total.inputTokens ? this.total.cacheReadTokens / this.total.inputTokens : null,
    } };
  }
}
