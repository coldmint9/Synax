import { describe, expect, it } from "vitest";
import { fingerprintRequest, compareRequests } from "../cache-diagnostics.js";

describe("fingerprint-only cache diagnostics", () => {
  const first = [
    {
      role: "system",
      content:
        "Stable instructions\n<reference-context>private-source-code</reference-context>",
    },
    { role: "user", content: "private-user-task" },
    { role: "user", content: "<system-reminder>\nstate-1\n</system-reminder>" },
  ];
  it("reports the tail as first difference, not a change in stable instructions or references", () => {
    const before = fingerprintRequest(first, [{ name: "read" }]);
    const after = fingerprintRequest(
      [
        ...first.slice(0, 2),
        {
          ...first[2],
          content: "<system-reminder>\nstate-2\n</system-reminder>",
        },
      ],
      [{ name: "read" }],
    );
    expect(compareRequests(before, after)).toMatchObject({
      stableSystem: true,
      stableTools: true,
      stableReferences: true,
      firstChange: { before: "runtime", after: "runtime" },
    });
    expect(compareRequests(before, before)).toMatchObject({
      unchanged: true,
      firstChange: null,
    });
    expect(JSON.stringify(before)).not.toContain("private");
    expect(JSON.stringify(before)).not.toContain("state-1");
  });
  it("separates real reference and tool changes, and recognizes append-only history", () => {
    const before = fingerprintRequest(first);
    expect(
      compareRequests(
        before,
        fingerprintRequest([
          ...first,
          { role: "assistant", content: "new evidence" },
        ]),
      ),
    ).toMatchObject({
      commonPrefixBlocks: before.blocks.length,
      stableReferences: true,
    });
    expect(
      compareRequests(
        before,
        fingerprintRequest([
          {
            ...first[0],
            content: first[0].content.replace("private-source-code", "updated"),
          },
          ...first.slice(1),
        ]),
      ),
    ).toMatchObject({ stableReferences: false, stableSystem: true });
    expect(
      compareRequests(before, fingerprintRequest(first, [{ name: "write" }])),
    ).toMatchObject({ stableTools: false, firstChange: { index: 0 } });
  });
});

it("groups provider-reported usage with matching denominators and preserves unknown fields", async () => {
  const { summarizeCacheMeasurements } =
    await import("../cache-diagnostics.js");
  const source = {
    provider: "fixture",
    model: "model",
    source: "main",
    phase: "continuous",
  };
  const groups = await summarizeCacheMeasurements([
    {
      ...source,
      usage: { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
    },
    {
      ...source,
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
    { ...source, usage: { inputTokens: 5000 } },
    { ...source, source: "auxiliary" },
  ]);
  expect(groups[0]).toMatchObject({
    requests: 3,
    matchedInput: 11000,
    cacheRead: 8000,
    cacheReadRate: 8000 / 11000,
    cacheReadCoverage: 2 / 3,
    cost: null,
    firstTokenMs: null,
  });
  expect(groups[1]).toMatchObject({
    cacheRead: null,
    cacheReadRate: null,
    cacheWrite: null,
  });
});
