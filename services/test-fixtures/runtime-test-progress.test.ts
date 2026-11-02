import type { TestCase, TestModule, TestSpecification, Vitest } from "vitest/node";
import { afterEach, expect, it, vi } from "vitest";
import RuntimeTestProgress from "./runtime-test-progress.js";

afterEach(() => vi.useRealTimers());

it("reports slow imports and clears its heartbeat after completion", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const reporter = new RuntimeTestProgress();
  reporter.onInit({ logger: { log } } as unknown as Vitest);
  reporter.onTestRunStart([{}] as TestSpecification[]);
  const module = { relativeModuleId: "slow.test.ts" } as TestModule;
  reporter.onTestModuleQueued(module);
  vi.advanceTimersByTime(15_000);
  expect(log.mock.calls.at(-1)?.[0]).toContain("slow.test.ts (15s)");
  const test = { module, fullName: "waits for a worker" } as TestCase;
  reporter.onTestCaseReady(test);
  vi.advanceTimersByTime(15_000);
  expect(log.mock.calls.at(-1)?.[0]).toContain("waits for a worker (15s)");
  reporter.onTestCaseResult(test);
  reporter.onTestModuleEnd(module);
  reporter.onTestRunEnd();
  expect(log.mock.calls.at(-1)?.[0]).toContain("1/1 files finished");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not keep a timer alive when teardown times out", () => {
  vi.useFakeTimers();
  const reporter = new RuntimeTestProgress();
  reporter.onTestRunStart([]);
  reporter.onProcessTimeout();
  expect(vi.getTimerCount()).toBe(0);
});
