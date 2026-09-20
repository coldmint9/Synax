import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
};

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-config-routes-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "route-test-secret";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterEach(async () => {
  const dbModule = await import("../../db/index.js");
  dbModule.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY;
});

describe("removed extension metrics routes", () => {
  it.each([
    ["GET", "/provider-metrics"],
    ["PATCH", "/provider-metrics"],
    ["POST", "/provider-metrics/discover"],
  ])(
    "does not expose removed extension metrics endpoint: %s %s",
    async (method, url) => {
      const { configRoutes } = await import("../config.js");
      const response = await configRoutes.request(url, { method });
      expect(response.status).toBe(404);
    },
  );
});
