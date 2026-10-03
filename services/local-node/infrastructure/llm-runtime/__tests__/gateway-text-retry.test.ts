import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../runtime/config/config-store.js", () => ({
  getGlobalConfigForRuntime: () => ({}),
  getProjectConfigForRuntime: () => ({}),
}));
vi.mock("../catalog.js", () => ({ getRuntimeCatalog: async () => ({}) }));
vi.mock("../resolver.js", () => ({
  resolveLlmSelection: () => ({ providerId: "fixture", modelId: "model" }),
}));
vi.mock("../pipeline.js", () => ({ executePipeline: mocks.execute }));
vi.mock("../middleware/rate-limiter.js", () => ({
  withRateLimit: (_provider: string, _model: string, _tokens: number, run: () => Promise<unknown>) => run(),
}));

import { generateGatewayTextResult } from "../gateway.js";

const request = {
  purpose: "input-optimization",
  model: "fixture/model",
  messages: [{ role: "user" as const, content: "draft" }],
};

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it("does not retry transient provider failures when the caller disables retries", async () => {
  const error = Object.assign(new Error("Service unavailable"), { statusCode: 503 });
  mocks.execute.mockRejectedValue(error);
  await expect(generateGatewayTextResult({ ...request, maxRetries: 0 })).rejects.toBe(error);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it.each([undefined, 1])("preserves retry behavior for maxRetries=%s", async (maxRetries) => {
  vi.useFakeTimers();
  const result = { text: "edited", finishReason: "stop" };
  mocks.execute
    .mockRejectedValueOnce(Object.assign(new Error("Service unavailable"), { statusCode: 503 }))
    .mockResolvedValue(result);
  const pending = generateGatewayTextResult({ ...request, maxRetries });
  const assertion = expect(pending).resolves.toEqual(result);
  await vi.runAllTimersAsync();
  await assertion;
  expect(mocks.execute).toHaveBeenCalledTimes(2);
});
