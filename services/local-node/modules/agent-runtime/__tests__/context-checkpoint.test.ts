import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_MAX_REFS,
  contextInputBudget,
  parseContextCheckpoint,
  type ContextCheckpoint,
} from "../context-checkpoint.js";

const checkpoint = (): ContextCheckpoint => ({
  version: 1, id: "cmp-1", sessionId: "session", compactionRunId: "run-compact",
  throughRevision: 15, throughStepId: "step-10",
  summary: {
    goal: ["Investigate the error"], constraints: ["Keep the source history"],
    decisions: [], completedWork: [], evidence: ["step-10: observed failure"],
    failures: [], openQuestions: [], nextActions: ["Read step-10"],
  },
  sourceRefs: ["step-10"], sourceFingerprint: "a".repeat(64), createdAt: "2026-10-23T08:00:00Z",
});
const parse = (value: unknown, tokens = 100, budget?: number) =>
  parseContextCheckpoint(JSON.stringify(value), () => tokens, budget);

describe("bounded checkpoint wire format", () => {
  it("accepts a logical boundary without an embedded history/index", () => {
    expect(parse(checkpoint())).toEqual(checkpoint());
  });

  it.each(["historyIndex", "transcript", "previousCheckpoint"])("rejects embedded %s", field => {
    expect(() => parse({ ...checkpoint(), [field]: [] })).toThrow();
  });

  it("bounds references, ids and duplicates before persistence", () => {
    expect(() => parse({ ...checkpoint(), sourceRefs: Array.from({ length: CHECKPOINT_MAX_REFS + 1 }, (_, n) => `step-${n}`) })).toThrow();
    expect(() => parse({ ...checkpoint(), sourceRefs: ["step-10", "step-10"] })).toThrow();
    expect(() => parse({ ...checkpoint(), sourceRefs: ["文".repeat(86)] })).toThrow();
  });

  it("bounds encoded UTF-8 before parsing or tokenization", () => {
    let counted = false;
    expect(() => parseContextCheckpoint("文".repeat(CHECKPOINT_MAX_BYTES / 2), () => { counted = true; return 0; })).toThrow("checkpoint_too_large");
    expect(counted).toBe(false);
  });

  it("enforces the actual summary budget including structure", () => {
    expect(parse(checkpoint(), 100, 100)).toEqual(checkpoint());
    expect(() => parse(checkpoint(), 101, 100)).toThrow("checkpoint_summary_exceeds_budget");
    expect(() => parse(checkpoint(), NaN)).toThrow("checkpoint_summary_exceeds_budget");
    expect(() => parse(checkpoint(), 100, 0)).toThrow("invalid_checkpoint_budget");
  });

  it("rejects invalid revisions, fingerprints and format versions", () => {
    for (const patch of [{ throughRevision: -1 }, { throughRevision: Number.MAX_SAFE_INTEGER + 1 }, { sourceFingerprint: "unknown" }, { version: 2 }])
      expect(() => parse({ ...checkpoint(), ...patch })).toThrow();
  });

  it("checkpoint record size stays bounded as the history boundary grows", () => {
    const sizes = [10, 10_000, 10_000_000].map(throughRevision => {
      const text = JSON.stringify({ ...checkpoint(), throughRevision });
      parseContextCheckpoint(text, () => 100);
      return text.length;
    });
    expect(sizes[2] - sizes[0]).toBeLessThan(10);
  });
});

describe("independent provider limits", () => {
  it.each([
    [{ contextLimit: 1000, outputReserve: 200 }, 800],
    [{ contextLimit: 1000, inputLimit: 700, outputReserve: 200 }, 700],
    [{ contextLimit: 1000, inputLimit: 900, outputReserve: 200 }, 800],
  ])("calculates input capacity once: %j", (budget, expected) => {
    expect(contextInputBudget(budget)).toBe(expected);
  });

  it("rejects impossible or non-integer budgets", () => {
    for (const patch of [{ outputReserve: 1000 }, { outputReserve: 0 }, { contextLimit: NaN }, { inputLimit: 0 }, { inputLimit: 700.5 }])
      expect(() => contextInputBudget({ contextLimit: 1000, outputReserve: 200, ...patch })).toThrow();
  });
});
