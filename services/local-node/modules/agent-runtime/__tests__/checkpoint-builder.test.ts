import { describe, expect, it, vi } from "vitest";
import { buildContextCheckpoint, type CheckpointBuilderInput, type CheckpointTextSlice } from "../checkpoint-builder.js";

const summary = { goal: ["Investigate"], constraints: ["Keep original evidence"], decisions: [], completedWork: [], evidence: [], failures: [], openQuestions: [], nextActions: ["Read the evidence"] };
const identity = { version: 1 as const, id: "cmp", sessionId: "s", compactionRunId: "run-cmp", throughRevision: 100, throughStepId: "step", sourceFingerprint: "a".repeat(64), createdAt: "2026-10-23T00:00:00Z" };
async function* pages(items: CheckpointTextSlice[]) { for (let i = 0; i < items.length; i += 8) yield items.slice(i, i + 8); }
function input(overrides: Partial<CheckpointBuilderInput> = {}): CheckpointBuilderInput {
  return {
    identity, previous: null,
    pages: pages([{ objectId: "object-1", role: "assistant", text: "Observed error", offset: 0 }]),
    budget: { contextLimit: 5000, inputLimit: 4000, outputReserve: 1000 }, summaryBudget: 500,
    countTokens: text => Math.ceil(text.length / 3), signal: new AbortController().signal,
    generate: vi.fn(async () => ({ text: JSON.stringify({ summary, sourceRefs: [] }), finishReason: "stop" })),
    ...overrides,
  };
}

describe("incremental checkpoint builder", () => {
  it("keeps a valid summary when the provider emits stale source references", async () => {
    const result = await buildContextCheckpoint({
      ...input(),
      pages: (async function* () { yield [{ objectId: "sha256:valid", role: "assistant", text: "Evidence" , offset: 0 }]; })(),
      generate: vi.fn(async () => ({ finishReason: "stop", text: JSON.stringify({
        summary: { goal: [], constraints: [], decisions: [], completedWork: ["Evidence"], evidence: [], failures: [], openQuestions: [], nextActions: [] },
        sourceRefs: ["sha256:valid", "sha256:stale"],
      }) })),
    });
    expect(result?.sourceRefs).toEqual(["sha256:valid"]);
  });
  it("combines small records into a bounded call instead of summarizing each message", async () => {
    const args = input({ pages: pages(Array.from({ length: 60 }, (_, i) => ({ objectId: `o-${i}`, role: "tool", text: "done", offset: 0 }))) });
    expect(await buildContextCheckpoint(args)).toMatchObject({ summary });
    expect(args.generate).toHaveBeenCalledTimes(1);
  });

  it("splits large UTF-16 text without exceeding either provider limit", async () => {
    const args = input({ pages: pages([{ objectId: "o", role: "tool", text: "检查 🦀 ".repeat(2500), offset: 0 }]) });
    const result = await buildContextCheckpoint(args);
    expect(result?.summary).toEqual(summary);
    const calls = vi.mocked(args.generate).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [request] of calls) {
      expect(args.countTokens(request.data) + args.countTokens(request.instructions) + 128).toBeLessThanOrEqual(4000);
      expect(request.data.isWellFormed()).toBe(true);
    }
  });

  it("accepts a complete JSON response even when the provider marks the stream length-limited", async () => {
    const args = input({ generate: vi.fn(async () => ({ text: JSON.stringify({ summary, sourceRefs: [] }), finishReason: "length" })) });
    await expect(buildContextCheckpoint(args)).resolves.toMatchObject({ summary });
    expect(args.generate).toHaveBeenCalledTimes(1);
  });

  it("filters invented refs while keeping valid evidence links", async () => {
    const generate = vi.fn().mockResolvedValue({ text: JSON.stringify({ summary, sourceRefs: ["invented", "object-1"] }), finishReason: "stop" });
    expect(await buildContextCheckpoint(input({ generate }))).toMatchObject({ sourceRefs: ["object-1"] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("commits a deterministic checkpoint when the provider returns malformed JSON", async () => {
    const result = await buildContextCheckpoint(input({
      generate: vi.fn(async () => ({ text: '{"summary":', finishReason: "length" })),
    }));
    expect(result?.summary.evidence).toContain("Observed error");
    expect(result?.summary.nextActions).toContain("Continue from the latest completed step.");
  });

  it("commits a deterministic checkpoint when the provider call throws", async () => {
    const result = await buildContextCheckpoint(input({
      generate: vi.fn(async () => { throw new Error("provider temporarily unavailable"); }),
    }));
    expect(result?.summary.evidence).toContain("Observed error");
  });

  it("keeps a minimal checkpoint when a history page fails", async () => {
    async function* failingPages() {
      throw new Error("history page temporarily unavailable");
    }
    const result = await buildContextCheckpoint(input({ pages: failingPages() }));
    expect(result?.summary.nextActions).toContain("Continue from the latest completed step.");
  });

  it("does not accept a late response after cancellation", async () => {
    const controller = new AbortController();
    const args = input({ signal: controller.signal, generate: async () => {
      controller.abort(new Error("cancelled"));
      return { text: JSON.stringify({ summary, sourceRefs: [] }), finishReason: "stop" };
    } });
    await expect(buildContextCheckpoint(args)).rejects.toThrow("cancelled");
  });

  it("does not call the model when no new history exists", async () => {
    const args = input({ previous: { summary, sourceRefs: [] }, pages: pages([]) });
    expect(await buildContextCheckpoint(args)).toBeNull();
    expect(args.generate).not.toHaveBeenCalled();
  });

  it("request count and token work depend on new data, not the sealed revision", async () => {
    const run = async (throughRevision: number) => {
      let bytes = 0;
      const args = input({ identity: { ...identity, throughRevision }, previous: { summary, sourceRefs: ["old-ref"] },
        countTokens: text => { bytes += text.length; return Math.ceil(text.length / 3); } });
      await buildContextCheckpoint(args);
      return { bytes, calls: vi.mocked(args.generate).mock.calls.length };
    };
    expect(await run(1_000_000)).toEqual(await run(100));
  });

  it("does not recount the entire remainder when a large record needs many small chunks", async () => {
    const measure = async (length: number) => {
      let scanned = 0;
      const args = input({ budget: { contextLimit: 2400, inputLimit: 1800, outputReserve: 600 }, summaryBudget: 400,
        pages: pages([{ objectId: "o", role: "tool", text: "x".repeat(length), offset: 0 }]),
        countTokens: text => { scanned += text.length; return text.length; } });
      await buildContextCheckpoint(args);
      return scanned;
    };
    const small = await measure(8000);
    const large = await measure(32_000);
    expect(large).toBeLessThan(small * 5);
  });
});
