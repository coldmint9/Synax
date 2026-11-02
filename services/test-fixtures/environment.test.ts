import { afterEach, expect, it, vi } from "vitest";
import { prepareTestProcessEnvironment } from "./environment.js";

afterEach(() => vi.unstubAllEnvs());

it("isolates direct Vitest invocations from a desktop host before application imports", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATA_ROOT", "/production/data");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SOCKET", "/production/runtime.sock");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "production-secret");
  vi.stubEnv("SYNAX_RUNTIME_STORE_PATH", "/production/data/jsonl");
  vi.stubEnv("SYNAX_RUNTIME_LOG_DIR", "/production/logs");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_BIN", "/test/custom-sidecar");
  vi.stubEnv("SYNAX_AGENT_SESSION_CHILD", "1");
  prepareTestProcessEnvironment();
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.DATA_ROOT).toBeUndefined();
  expect(process.env.SYNAX_AGENT_SESSION_CHILD).toBeUndefined();
  expect(Object.keys(process.env).filter(key => key.startsWith("SYNAX_RUNTIME_"))).toEqual([]);
  vi.resetModules();
  const { DATA_ROOT } = await import("../local-node/infrastructure/runtime/env.js");
  expect(DATA_ROOT).toContain("Synax-vitest-");
  expect(DATA_ROOT).not.toContain("/production");
});

it("retains a custom test binary when no host connection is inherited", () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATA_ROOT", "/test/unused");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SOCKET", undefined);
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SUPERVISOR", undefined);
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_BIN", "/test/custom-sidecar");
  prepareTestProcessEnvironment();
  expect(process.env.SYNAX_RUNTIME_SIDECAR_BIN).toBe("/test/custom-sidecar");
});
