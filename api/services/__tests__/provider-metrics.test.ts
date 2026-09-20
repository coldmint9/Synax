import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

const originalDataRoot = process.env.DATA_ROOT;
let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-metrics-"));
  process.env.DATA_ROOT = tempDir;
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../db/index.js")).closeDb();
  if (originalDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = originalDataRoot;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const schema = {
  version: 1,
  fields: [
    {
      path: "usage.credit_usage",
      type: "number",
      label: "Credits",
      unit: "credit",
      aggregation: "sum",
    },
    {
      path: "usage.balance",
      type: "number",
      label: "Balance",
      unit: "credit",
      aggregation: "latest",
    },
  ],
};

describe("provider metric ledger", () => {
  it("discovers bounded nested scalar extensions without token counters, credentials or raw objects", async () => {
    const { extractExtendedUsage } = await import("../provider-metrics.js");
    const fields = extractExtendedUsage({
      prompt_tokens: 10,
      input_tokens: 10,
      output_tokens: 2,
      prompt_tokens_details: { cached_tokens: 5, energy: 0.2 },
      billing: { amount: 0, unit: "USD", promotional: false, note: "included" },
      api_key: "short-secret",
      apiKey: "short-secret",
      refreshToken: "short-secret",
      credential: { nested: "hidden" },
      note: "sk-some-secret-credential",
      long: "x".repeat(400),
      invalid: Infinity,
      array: [1, 2],
      absent: null,
      __proto__: { polluted: "no" },
    });
    expect(fields).toEqual({
      "usage.prompt_tokens_details.energy": 0.2,
      "usage.billing.amount": 0,
      "usage.billing.unit": "USD",
      "usage.billing.promotional": false,
      "usage.billing.note": "included",
    });
    expect(
      Object.keys(
        extractExtendedUsage(
          Object.fromEntries(
            Array.from({ length: 1000 }, (_, i) => [`metric${i}`, i]),
          ),
        ),
      ),
    ).toHaveLength(64);
  });

  it("stores one final value per request, isolates providers/sessions and enables retroactive totals", async () => {
    const m = await import("../provider-metrics.js");
    m.declareProviderMetrics("a", schema);
    const values = m.mergeExtendedUsage(
      m.extractExtendedUsage({ credit_usage: 0.1 }),
      { credit_usage: 0.3, credit_unit: "CREDITS", balance: 9.7 },
    );
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "request-1",
      sessionId: "session-1",
      values,
    });
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "request-1",
      sessionId: "session-1",
      values: { "usage.credit_usage": 500 },
    });
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "request-2",
      sessionId: "session-1",
      values: { "usage.credit_usage": 0 },
    });
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "request-3",
      sessionId: "session-2",
      values: { "usage.credit_usage": 0.2 },
    });
    m.observeProviderMetrics({
      providerId: "b",
      requestId: "request-1",
      sessionId: "session-3",
      values: { "usage.credit_usage": 50 },
    });
    let fields = m.listProviderMetrics({ providerId: "a" });
    const credit = fields.find((field) => field.path === "usage.credit_usage")!;
    expect(fields.filter((field) => field.path === credit.path)).toHaveLength(
      1,
    );
    expect(credit).toMatchObject({
      count: 3,
      visible: false,
      accumulate: false,
      unit: "credit",
    });
    expect(credit.total).toBeUndefined();
    m.configureProviderMetric({
      id: credit.id,
      accumulate: true,
      visible: true,
    });
    fields = m.listProviderMetrics({ sessionId: "session-1" });
    expect(fields.every((field) => field.providerId === "a")).toBe(true);
    expect(fields.find((field) => field.id === credit.id)).toMatchObject({
      count: 2,
      total: 0.3,
      lastValue: 0,
    });
    expect(
      m
        .listProviderMetrics({ providerId: "a" })
        .find((field) => field.id === credit.id),
    ).toMatchObject({ count: 3, total: 0.5 });
    expect(
      m
        .listProviderMetrics({ providerId: "a", sessionId: "missing" })
        .find((field) => field.id === credit.id),
    ).toMatchObject({ count: 0 });
    expect(
      m
        .listProviderMetrics({ providerId: "a", sessionId: "missing" })
        .find((field) => field.id === credit.id)?.total,
    ).toBeUndefined();
    const balance = fields.find((field) => field.path === "usage.balance")!;
    expect(balance).toMatchObject({ aggregation: "latest", accumulate: false });
  });

  it("persists settings and deduplication across a database reopen", async () => {
    const m = await import("../provider-metrics.js");
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "persisted",
      values: { "usage.custom.amount": 1.25 },
    });
    const [field] = m.listProviderMetrics();
    m.configureProviderMetric({
      id: field.id,
      visible: true,
      accumulate: true,
    });
    (await import("../../db/index.js")).closeDb();
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "persisted",
      values: { "usage.custom.amount": 1.25 },
    });
    expect(m.listProviderMetrics()).toEqual([
      expect.objectContaining({
        id: field.id,
        count: 1,
        total: 1.25,
        visible: true,
        accumulate: true,
      }),
    ]);
  });

  it("keeps changed units and scalar types separate and rejects summing categorical fields", async () => {
    const m = await import("../provider-metrics.js");
    for (const [index, unit] of ["credit", "USD"].entries())
      m.observeProviderMetrics({
        providerId: "a",
        requestId: `req-${index}`,
        values: m.extractExtendedUsage({
          billing: { amount: index + 1, unit },
        }),
      });
    m.observeProviderMetrics({
      providerId: "a",
      requestId: "text",
      values: m.extractExtendedUsage({ billing: { amount: "unknown" } }),
    });
    const amount = m
      .listProviderMetrics()
      .filter((field) => field.path === "usage.billing.amount");
    expect(amount).toHaveLength(3);
    expect(new Set(amount.map((field) => field.id)).size).toBe(3);
    expect(() =>
      m.configureProviderMetric({
        id: amount.find((field) => field.type === "string")!.id,
        accumulate: true,
      }),
    ).toThrow("Only numeric");
  });

  it("offers declared fields for the current session model before the first request", async () => {
    const { updateGlobalConfig } =
      await import("../../lib/config/config-store.js");
    updateGlobalConfig({ defaultApiProviderId: "openai" }, "test");
    const m = await import("../provider-metrics.js");
    m.declareProviderMetrics("openai", schema);
    m.declareProviderMetrics("anthropic", schema);
    const db = (await import("../../db/index.js")).getRawSqlite();
    db.prepare(
      `INSERT INTO agent_runtime_sessions (id, project_id, profile_id, status, prompt, thinking_mode, created_at, updated_at, session_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "new-session",
      "project",
      "default",
      "idle",
      "",
      "off",
      "now",
      "now",
      JSON.stringify({
        backend: { id: "native", model: "anthropic/claude-fixture" },
      }),
    );
    expect(m.listProviderMetrics({ sessionId: "new-session" })).toEqual([
      expect.objectContaining({
        providerId: "anthropic",
        path: "usage.balance",
        count: 0,
      }),
      expect.objectContaining({
        providerId: "anthropic",
        path: "usage.credit_usage",
        count: 0,
      }),
    ]);
  });
});

const sdkUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: sdkUsage,
};
function model(
  parts: () => LanguageModelV4StreamPart[],
  body?: unknown,
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: sdkUsage,
      warnings: [],
      response: { body },
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          parts().forEach((part) => controller.enqueue(part));
          controller.close();
        },
      }),
    }),
  };
}

describe("wire extension capture", () => {
  it("preserves extensions from the original non-stream body after SDK schema stripping", async () => {
    const { applyUsageMiddleware } =
      await import("../llm-runtime/middleware/usage.js");
    const wrapped = applyUsageMiddleware(
      model(() => [], {
        usage: {
          prompt_tokens: 10,
          credit_usage: 0.25,
          credit_unit: "credit",
          api_key: "hidden",
        },
      }),
      { providerId: "a", sessionId: "s" },
    );
    const result = await wrapped.doGenerate({ prompt: [] });
    expect(result.usage.raw).toMatchObject({
      prompt_tokens: 10,
      credit_usage: 0.25,
      credit_unit: "credit",
    });
    expect(result.usage.raw).not.toHaveProperty("api_key");
    const { listProviderMetrics } = await import("../provider-metrics.js");
    expect(
      listProviderMetrics({ sessionId: "s" }).find(
        (field) => field.path === "usage.credit_usage",
      ),
    ).toMatchObject({ count: 1, lastValue: 0.25 });
  });

  it("merges Chat/Anthropic/Responses stream usage and records one final snapshot per concurrent request", async () => {
    const { applyUsageMiddleware } =
      await import("../llm-runtime/middleware/usage.js");
    let n = 0;
    const wrapped = applyUsageMiddleware(
      model(() => {
        const value = ++n;
        return [
          {
            type: "raw",
            rawValue: {
              message: {
                usage: { credit_usage: 0.1, billing: { unit: "credit" } },
              },
            },
          },
          {
            type: "raw",
            rawValue: { usage: { credit_usage: value, credit_unit: "credit" } },
          },
          {
            type: "raw",
            rawValue: {
              response: {
                usage: { credit_usage: value + 0.5, billing: { amount: 1 } },
              },
            },
          },
          finish,
          finish,
        ];
      }),
      { providerId: "a", sessionId: "s" },
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const result = await wrapped.doStream({ prompt: [] });
        const reader = result.stream.getReader();
        while (!(await reader.read()).done) {
          /* consume */
        }
      }),
    );
    const m = await import("../provider-metrics.js");
    const field = m
      .listProviderMetrics()
      .find((item) => item.path === "usage.credit_usage")!;
    m.configureProviderMetric({ id: field.id, accumulate: true });
    expect(
      m.listProviderMetrics().find((item) => item.id === field.id),
    ).toMatchObject({ count: 4, total: 12 });
  });

  it("does not synthesize extension zeroes for missing usage", async () => {
    const { applyUsageMiddleware } =
      await import("../llm-runtime/middleware/usage.js");
    const wrapped = applyUsageMiddleware(
      model(() => [finish], { usage: { input_tokens: 10 } }),
      { providerId: "a" },
    );
    await wrapped.doGenerate({ prompt: [] });
    const response = await wrapped.doStream({ prompt: [] });
    const reader = response.stream.getReader();
    while (!(await reader.read()).done) {
      /* consume */
    }
    expect(
      (await import("../provider-metrics.js")).listProviderMetrics(),
    ).toEqual([]);
  });
});
