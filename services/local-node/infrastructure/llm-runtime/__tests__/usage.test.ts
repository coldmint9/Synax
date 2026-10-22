import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUsage, normalizeResultUsage } from "../usage.js";

import { aggregateUsage, whitelistRawUsage } from "../usage.js";
import { llmHooks } from "../llm-hooks.js";
const gateway = vi.hoisted(() => ({ createGatewayStream: vi.fn() }));
vi.mock("../gateway.js", () => ({
  ...gateway,
  createGatewayStreamForSelection: (...args: unknown[]) =>
    gateway.createGatewayStream(...args),
  resolveGatewaySelection: async () => ({
    providerId: "fixture",
    modelId: "fixture",
    apiFormat: "openai",
    provider: { npm: "@ai-sdk/openai-compatible" },
    config: {},
  }),
}));

afterEach(() => llmHooks.unregister("usage-test"));
const normalized = (value: unknown) => normalizeUsage(value)!;

describe("source-aware usage", () => {
  it("uses raw compatible cache hits over SDK synthetic zero", () => {
    expect(
      normalizeUsage({
        inputTokens: 10000,
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
      })?.cachedInputTokens,
    ).toBe(8000);
  });
});

describe("presence, validation and provenance", () => {
  it("honors a raw standard zero before a positive custom alias", () => {
    const u = normalized({
      raw: {
        prompt_tokens: 10000,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBe(0);
    expect(u.normalization.cacheRead).toEqual({
      status: "known",
      value: 0,
      source: "raw:prompt_tokens_details.cached_tokens",
      rawPresent: true,
    });
  });
  it.each([
    null,
    "8000",
    -1,
    1.5,
    Infinity,
    NaN,
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ])("does not hide invalid standard fields (%s)", (value) => {
    const u = normalized({
      cachedInputTokens: 6000,
      raw: {
        prompt_tokens_details: { cached_tokens: value },
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.normalization.cacheRead).toMatchObject({
      status: "unknown",
      rawPresent: true,
    });
  });
  it("does not count inherited fields as wire evidence", () => {
    const u = normalized({
      raw: {
        prompt_tokens_details: Object.create({ cached_tokens: 0 }),
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBe(8000);
  });
  it("keeps missing, invalid and ambiguous old SDK zero unknown", () => {
    for (const u of [
      {},
      { inputTokens: "100" },
      { cachedInputTokens: 0 },
      { inputTokenDetails: { cacheReadTokens: 0 } },
    ]) {
      expect(normalized(u).normalization.cacheRead.status).toBe("unknown");
    }
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage([])).toBeUndefined();
    expect(
      normalized({ inputTokens: -3, outputTokens: NaN }).totalTokens,
    ).toBeUndefined();
  });
  it("does not retain arbitrary wire content", () => {
    const raw = whitelistRawUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: "SECRET",
      content: "SECRET",
      prompt_tokens_details: { cached_tokens: 80, content: "SECRET" },
    });
    expect(raw).toEqual({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: null,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(JSON.stringify(raw)).not.toContain("SECRET");
  });
  it("is idempotent even after JSON persistence", () => {
    const first = normalized({
      raw: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1000,
      },
    });
    expect(first.inputTokens).toBe(9100);
    expect(normalizeUsage(first)).toBe(first);
    const saved = JSON.parse(JSON.stringify(first));
    expect(normalizeUsage(saved)).toEqual(saved);
  });
  it("adds Anthropic raw components once and never re-adds to SDK totals", () => {
    const raw = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1000,
        ephemeral_1h_input_tokens: 0,
      },
    };
    expect(normalized({ raw }).inputTokens).toBe(9100);
    expect(normalized({ inputTokens: 9100, raw }).inputTokens).toBe(9100);
    expect(
      normalizeUsage(
        { inputTokens: 9100, cachedInputTokens: 8000, cacheWriteTokens: 1000 },
        { protocol: "anthropic", source: "sdk" },
      )?.inputTokens,
    ).toBe(9100);
    expect(
      normalizeUsage(
        { input_tokens: 100, cache_read_input_tokens: 8000 },
        { protocol: "anthropic" },
      )?.inputTokens,
    ).toBeUndefined();
  });
  it("derives cache writes only with all detail components and prefers a present total", () => {
    const cache_creation = {
      ephemeral_5m_input_tokens: 20,
      ephemeral_1h_input_tokens: 30,
    };
    expect(normalized({ raw: { cache_creation } }).cacheWriteTokens).toBe(50);
    expect(
      normalized({ raw: { cache_creation, cache_creation_input_tokens: 0 } })
        .cacheWriteTokens,
    ).toBe(0);
    expect(
      normalized({ raw: { cache_creation: { ephemeral_5m_input_tokens: 20 } } })
        .cacheWriteTokens,
    ).toBeUndefined();
  });
  it("keeps Responses input inclusive and reasoning separate from output", () => {
    const u = normalized({
      raw: {
        input_tokens: 10000,
        input_tokens_details: { cached_tokens: 8000 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 75 },
      },
    });
    expect(u).toMatchObject({
      inputTokens: 10000,
      cachedInputTokens: 8000,
      outputTokens: 100,
      reasoningTokens: 75,
      totalTokens: 10100,
    });
  });
  it("aggregates steps strictly instead of counting finish usage twice", () => {
    const a = normalized({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
    });
    const b = normalized({
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 20,
    });
    expect(aggregateUsage([a, b])).toMatchObject({
      inputTokens: 1100,
      outputTokens: 30,
      cachedInputTokens: 100,
    });
    expect(
      aggregateUsage([a, normalized({ inputTokens: 200 })])?.cachedInputTokens,
    ).toBeUndefined();
    expect(aggregateUsage([a])).toBe(a);
  });
});

describe("ACP and CLI compatibility", () => {
  it.each(["codex", "claude-code", "cli"])(
    "recognizes %s aliases and already inclusive input",
    (source) => {
      const u = normalized({
        source,
        inputTokens: 10000,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteTokens: 50,
      });
      expect(u).toMatchObject({
        inputTokens: 10000,
        cachedInputTokens: 0,
        cacheWriteTokens: 50,
      });
      expect(u.normalization.source).toBe("cli");
    },
  );
});

describe("auxiliary result usage normalization", () => {
  const first = {
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 0 },
    },
    providerMetadata: {
      synaxUsage: {
        version: 1,
        protocol: "openai-chat",
        adapter: "@ai-sdk/openai-compatible",
        raw: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 80,
        },
      },
    },
  };
  const second = {
    usage: {
      inputTokens: 1000,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 0 },
    },
    providerMetadata: {
      synaxUsage: {
        version: 1,
        raw: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 100,
        },
      },
    },
  };
  it("normalizes each actual step with its own metadata and aggregates once", () => {
    const u = normalizeResultUsage({
      steps: [first, second],
      usage: second.usage,
      totalUsage: { inputTokens: 1100, outputTokens: 30, cachedInputTokens: 0 },
      providerMetadata: second.providerMetadata,
    });
    expect(u).toMatchObject({
      inputTokens: 1100,
      outputTokens: 30,
      cachedInputTokens: 180,
    });
    expect(u?.normalization.cacheRead).toMatchObject({
      status: "known",
      source: "steps",
    });
  });
  it("keeps missing step components unknown instead of dropping a sample or using SDK totals", () => {
    const u = normalizeResultUsage({
      steps: [first, {}],
      totalUsage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
    });
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.cacheRead.status).toBe("unknown");
    expect(u?.normalization.protocol).toBeUndefined();
    expect(u?.normalization.adapter).toBeUndefined();
    expect(u).not.toHaveProperty("measuredAt");
    expect(u).not.toHaveProperty("durationMs");
  });
  it("retains single-step provenance and never fills absent timing", () => {
    const u = normalizeResultUsage({ steps: [first] });
    expect(u).toEqual(
      normalizeUsage(first.usage, {
        source: "sdk",
        providerMetadata: first.providerMetadata,
      }),
    );
    expect(u?.normalization).toMatchObject({
      protocol: "openai-chat",
      adapter: "@ai-sdk/openai-compatible",
    });
    expect(u).not.toHaveProperty("measuredAt");
    expect(u).not.toHaveProperty("durationMs");
  });
  it.each([undefined, []])(
    "falls back to explicit single-result usage only when steps are absent/empty (%s)",
    (steps) => {
      const u = normalizeResultUsage({
        steps,
        ...first,
        totalUsage: { inputTokens: 99999, outputTokens: 99999 },
      });
      expect(u).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
      });
    },
  );
  it("never applies last-step metadata to a totals-only fallback", () => {
    const u = normalizeResultUsage({
      totalUsage: { inputTokens: 1100, outputTokens: 30, cachedInputTokens: 0 },
      providerMetadata: second.providerMetadata,
    });
    expect(u).toMatchObject({ inputTokens: 1100, outputTokens: 30 });
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.cacheRead.status).toBe("unknown");
    expect(u?.normalization.adapter).toBeUndefined();
    expect(u?.normalization.protocol).toBeUndefined();
  });
  it("returns absent usage rather than inventing an auxiliary measurement", () => {
    expect(normalizeResultUsage({})).toBeUndefined();
    expect(
      normalizeResultUsage({
        steps: [],
        providerMetadata: first.providerMetadata,
      }),
    ).toBeUndefined();
  });
});

describe("auxiliary protocol authority", () => {
  it.each(["openai-responses", "openai"])(
    "does not infer Anthropic from custom fields under explicit %s",
    (protocol) => {
      const raw = {
        input_tokens: 10000,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        cache_creation_input_tokens: 2000,
      };
      const expected = {
        inputTokens: 10000,
        cachedInputTokens: 0,
        normalization: {
          inputSemantics: "total",
          cacheRead: {
            status: "known",
            source: "raw:input_tokens_details.cached_tokens",
          },
        },
      };
      expect(normalizeUsage({ raw }, { protocol })).toMatchObject(expected);
      expect(
        normalizeResultUsage({
          steps: [
            {
              usage: { inputTokens: 10000, outputTokens: 20 },
              providerMetadata: { synaxUsage: { version: 1, protocol, raw } },
            },
          ],
        }),
      ).toMatchObject(expected);
      // Even a positive Anthropic-shaped read must not override the protocol's zero.
      expect(
        normalizeUsage(
          { raw: { ...raw, cache_read_input_tokens: 500 } },
          { protocol },
        ),
      ).toMatchObject(expected);
    },
  );
  it("still infers Anthropic for Claude CLI raw usage without a protocol", () => {
    const u = normalizeUsage({
      source: "claude-code",
      raw: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 2000,
      },
    });
    expect(u).toMatchObject({
      inputTokens: 10100,
      cachedInputTokens: 8000,
      cacheWriteTokens: 2000,
      normalization: {
        source: "cli",
        inputSemantics: "uncached",
        cacheRead: { source: "raw:cache_read_input_tokens" },
      },
    });
    expect(u?.normalization.protocol).toBeUndefined();
  });
});

describe("protocol-specific standard-field precedence", () => {
  const mixed = {
    input_tokens: 10000,
    input_tokens_details: { cached_tokens: 0 },
    prompt_tokens: 123,
    prompt_tokens_details: { cached_tokens: 999 },
  };
  it.each([
    ["openai-responses", 10000, 0, "input_tokens"],
    ["openai", 123, 999, "prompt_tokens"],
    ["openai-chat", 123, 999, "prompt_tokens"],
  ] as const)(
    "prefers the standard fields of %s in direct and auxiliary normalization",
    (protocol, inputTokens, cachedInputTokens, field) => {
      const expected = {
        inputTokens,
        cachedInputTokens,
        normalization: {
          input: { source: `raw:${field}` },
          cacheRead: { source: `raw:${field}_details.cached_tokens` },
        },
      };
      expect(normalizeUsage({ raw: mixed }, { protocol })).toMatchObject(
        expected,
      );
      expect(
        normalizeResultUsage({
          steps: [
            {
              usage: {},
              providerMetadata: {
                synaxUsage: { version: 1, protocol, raw: mixed },
              },
            },
          ],
        }),
      ).toMatchObject(expected);
    },
  );
  it("retains the generic Chat-first fallback for legacy records without a protocol", () => {
    expect(normalizeUsage({ raw: mixed })).toMatchObject({
      inputTokens: 123,
      cachedInputTokens: 999,
    });
  });
  it("does not hide present invalid Responses fields with unrelated valid Chat fields", () => {
    const u = normalizeUsage(
      {
        raw: {
          ...mixed,
          input_tokens: null,
          input_tokens_details: { cached_tokens: null },
        },
      },
      { protocol: "openai-responses" },
    );
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.input).toMatchObject({
      status: "unknown",
      source: "raw:input_tokens",
      rawPresent: true,
    });
    expect(u?.normalization.cacheRead).toMatchObject({
      status: "unknown",
      source: "raw:input_tokens_details.cached_tokens",
      rawPresent: true,
    });
  });
});
