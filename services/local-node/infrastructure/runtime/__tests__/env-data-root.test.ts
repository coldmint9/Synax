import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function dataRoot(root?: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("VITEST_WORKER_ID", undefined);
  vi.stubEnv("DATA_ROOT", root);
  return (await import("../env.js")).DATA_ROOT;
}

it("uses the same isolated Synax directory as the desktop and CLI", async () => {
  expect(await dataRoot()).toBe(path.join(os.homedir(), ".synax", "v2"));
});

it("preserves an explicitly configured data root", async () => {
  expect(await dataRoot("/custom/synax")).toBe("/custom/synax");
});
