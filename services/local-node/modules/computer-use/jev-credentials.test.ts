import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderConnection } from "../../infrastructure/runtime/config/config-types.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-jev-credentials-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "jev-credentials-test");
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../infrastructure/database/index.js")).closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("prefers the environment variable over the stored key", async () => {
  const { updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
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
  const { updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
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

function openRouterProvider() {
  return {
    id: "custom-api:openrouter",
    label: "OpenRouter",
    description: "OpenRouter OpenAI-compatible API",
    status: "live" as const,
    kind: "api" as const,
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "openai/gpt-4o-mini", label: "gpt-4o-mini", isDefault: true },
    ],
  };
}

async function configureOpenRouterJev(
  jev: Record<string, unknown>,
  connection: ProviderConnection = {
    providerId: "custom-api:openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-secret",
  },
) {
  const { updateGlobalConfig } =
    await import("../../infrastructure/runtime/config/config-store.js");
  updateGlobalConfig(
    {
      providers: [openRouterProvider()],
      providerConnections: { "custom-api:openrouter": connection },
      computerUse: { jev: { enabled: true, ...jev } },
    },
    "test",
  );
}

it("uses the selected provider connection endpoint, key, and model", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "env-key");
  await configureOpenRouterJev({
    providerId: "custom-api:openrouter",
    model: "jev-1.13",
  });
  const { resolveJevCredentials, describeJevCredentialSource } =
    await import("./jev-credentials.js");
  expect(resolveJevCredentials()).toEqual({
    apiKey: "sk-or-secret",
    baseURL: "https://openrouter.ai/api",
    model: "jev-1.13",
    providerId: "custom-api:openrouter",
    source: "provider",
  });
  expect(describeJevCredentialSource()).toBe("provider");
});

it("falls back to the environment key but keeps the provider endpoint", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "env-key");
  await configureOpenRouterJev(
    { providerId: "custom-api:openrouter" },
    { providerId: "custom-api:openrouter", baseUrl: "https://openrouter.ai/api" },
  );
  const { resolveJevCredentials } = await import("./jev-credentials.js");
  expect(resolveJevCredentials()).toEqual({
    apiKey: "env-key",
    baseURL: "https://openrouter.ai/api",
    providerId: "custom-api:openrouter",
    source: "env",
  });
});

it("normalizes the connection base URL before the SDK appends /v1/systemone", async () => {
  const { normalizeJevBaseUrl } = await import("./jev-credentials.js");
  expect(normalizeJevBaseUrl("https://openrouter.ai/api/v1")).toBe(
    "https://openrouter.ai/api",
  );
  expect(normalizeJevBaseUrl("https://openrouter.ai/api/v1/")).toBe(
    "https://openrouter.ai/api",
  );
  expect(normalizeJevBaseUrl("https://api.typesafe.ai")).toBe(
    "https://api.typesafe.ai",
  );
  expect(normalizeJevBaseUrl("   ")).toBeUndefined();
  expect(normalizeJevBaseUrl(undefined)).toBeUndefined();
});
