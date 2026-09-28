import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-jev-credentials-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "jev-credentials-test");
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../db/index.js")).closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("prefers the environment variable over the stored key", async () => {
  const { updateGlobalConfig } = await import("../../lib/config/config-store.js");
  updateGlobalConfig(
    { computerUse: { jev: { enabled: true, apiKey: "stored-key" } } },
    "test",
  );
  vi.stubEnv("TYPESAFE_API_KEY", "env-key");
  const { resolveJevCredentials, describeJevCredentialSource } =
    await import("./jev-credentials.js");
  expect(resolveJevCredentials()).toEqual({ apiKey: "env-key", source: "env" });
  expect(describeJevCredentialSource()).toBe("env");
});

it("falls back to the encrypted stored key", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const { updateGlobalConfig } = await import("../../lib/config/config-store.js");
  updateGlobalConfig(
    { computerUse: { jev: { enabled: true, apiKey: "stored-key" } } },
    "test",
  );
  const { resolveJevCredentials, describeJevCredentialSource } =
    await import("./jev-credentials.js");
  expect(resolveJevCredentials()).toEqual({ apiKey: "stored-key", source: "config" });
  expect(describeJevCredentialSource()).toBe("config");
});

it("reports missing credentials", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const { resolveJevCredentials, describeJevCredentialSource } =
    await import("./jev-credentials.js");
  expect(resolveJevCredentials()).toBeNull();
  expect(describeJevCredentialSource()).toBe("missing");
});
