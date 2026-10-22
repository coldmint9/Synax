import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown) => new Promise(resolve => globalThis.setTimeout(resolve, ms, value)),
}));
vi.mock("../../runtime/config/config-store.js", () => ({
  getGlobalConfigForRuntime: () => ({}),
  getProjectConfigForRuntime: () => ({}),
}));
vi.mock("../catalog.js", () => ({ getRuntimeCatalog: async () => ({}) }));
vi.mock("../resolver.js", () => ({
  resolveLlmSelection: () => ({ providerId: "fixture", modelId: "model" }),
}));
vi.mock("../pipeline.js", () => ({ executePipeline: mocks.execute }));


import { generateGatewayTextResult } from "../gateway.js";

const request = {
  purpose: "input-optimization",
  model: "fixture/model",
  messages: [{ role: "user" as const, content: "draft" }],
};

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it.each([429, 503, 599])("delegates HTTP %s retry ownership entirely to Rust", async statusCode => {
  const error = Object.assign(new Error("native retries exhausted"), { statusCode });
  mocks.execute.mockRejectedValue(error);
  await expect(generateGatewayTextResult(request)).rejects.toBe(error);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});
it.each([undefined, 0, 10])("passes maxRetries=%s to the native request", async maxRetries => {
  mocks.execute.mockResolvedValue({ text: "done" });
  await expect(generateGatewayTextResult({ ...request, maxRetries })).resolves.toEqual({ text: "done" });
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({ ...request, maxRetries }, expect.anything(), { kind: "text" }, undefined);
});
